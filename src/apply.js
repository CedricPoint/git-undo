/**
 * Running a plan.
 *
 * Two rules, and they are the whole point of this file:
 *
 *   1. A plan that would overwrite modified files refuses to run while there
 *      are modified files.
 *   2. Before anything executes, where HEAD points right now is written to a
 *      ref under refs/undo-backup/. Undoing the undo is then one command, and
 *      the commits can never be collected.
 */

import { git, repository, workingTree } from './git.js';

export const BACKUP_NAMESPACE = 'refs/undo-backup';

/**
 * @param {import('./analyze.js').Plan} plan
 * @param {string} [cwd]
 * @param {{ force?: boolean, now?: Date }} [options]
 */
export function apply(plan, cwd = process.cwd(), options = {}) {
  const repo = repository(cwd);
  if (!repo) return { ok: false, refused: 'no-repo', message: 'This is not a git repository.' };

  const tree = workingTree(cwd);
  if (plan.needsCleanTree && tree.trackedChanges > 0 && !options.force) {
    return {
      ok: false,
      refused: 'dirty',
      message:
        `${plural(tree.trackedChanges, 'file')} in your working tree ${tree.trackedChanges === 1 ? 'is' : 'are'} modified, ` +
        `and this undo would overwrite ${tree.trackedChanges === 1 ? 'it' : 'them'}.`,
      suggestion: 'Commit them, or run git stash -u first. Use --force to go ahead anyway.',
    };
  }

  const backup = repo.head ? `${BACKUP_NAMESPACE}/${stamp(options.now ?? new Date())}` : null;
  if (backup) {
    const written = git(['update-ref', backup, repo.head], cwd);
    if (written.code !== 0) {
      return { ok: false, refused: 'backup', message: `Could not write the backup ref: ${written.stderr}` };
    }
  }

  const result = git(plan.command, cwd);

  return {
    ok: result.code === 0,
    backup,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
    message: result.code === 0 ? null : result.stderr || 'git refused to run that.',
  };
}

/** Every backup this tool has written, newest first. */
export function backups(cwd = process.cwd()) {
  const result = git(
    ['for-each-ref', '--format=%(refname)%09%(objectname)', '--sort=-refname', BACKUP_NAMESPACE],
    cwd,
  );
  if (result.code !== 0 || !result.stdout) return [];

  return result.stdout.split(/\r?\n/).map((line) => {
    const [ref, sha] = line.split('\t');
    return { ref, sha, at: ref.slice(BACKUP_NAMESPACE.length + 1) };
  });
}

/**
 * A timestamp that is also a legal ref name: no colons, no dots, sortable.
 */
export function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
