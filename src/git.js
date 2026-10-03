/**
 * Everything that talks to git.
 *
 * Nothing here decides anything: it reads the repository and hands back plain
 * objects. The decisions live in analyze.js.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** ASCII unit separator: it cannot appear in a commit subject. */
const UNIT = '\x1f';

export class GitError extends Error {}

/**
 * Run git and return its result. Never throws on a non-zero exit — callers
 * decide whether that is a failure or an answer.
 *
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
export function git(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  if (result.error) {
    throw new GitError(
      result.error.code === 'ENOENT'
        ? 'git is not installed, or not on your PATH.'
        : `could not run git: ${result.error.message}`,
    );
  }

  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? '').replace(/\s+$/, ''),
    stderr: (result.stderr ?? '').replace(/\s+$/, ''),
  };
}

/** Run git and throw if it fails. */
export function capture(args, cwd) {
  const result = git(args, cwd);
  if (result.code !== 0) {
    throw new GitError(result.stderr || `git ${args.join(' ')} exited with ${result.code}`);
  }
  return result.stdout;
}

/**
 * Describe the repository around `cwd`, or null when there is none.
 *
 * @param {string} [cwd]
 */
export function repository(cwd = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (top.code !== 0) return null;

  const gitDirOutput = capture(['rev-parse', '--git-dir'], cwd);
  const gitDir = isAbsolute(gitDirOutput) ? gitDirOutput : resolve(cwd, gitDirOutput);

  const head = git(['rev-parse', 'HEAD'], cwd);
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  const changes = workingTree(cwd);

  return {
    root: top.stdout,
    gitDir,
    branch: branch.code === 0 ? branch.stdout : null,
    head: head.code === 0 ? head.stdout : null,
    subject: head.code === 0 ? git(['log', '-1', '--format=%s'], cwd).stdout : null,
    operation: operationInProgress(gitDir),
    ...changes,
  };
}

/**
 * What is sitting in the working tree.
 *
 * Tracked and untracked are counted apart on purpose: `git reset --hard`
 * destroys tracked changes and leaves untracked files alone, so only the
 * first number is a reason to refuse.
 */
export function workingTree(cwd) {
  const output = git(['status', '--porcelain=v1', '--untracked-files=normal'], cwd).stdout;
  const lines = output ? output.split(/\r?\n/) : [];
  const untracked = lines.filter((line) => line.startsWith('??')).length;

  return { trackedChanges: lines.length - untracked, untrackedFiles: untracked };
}

/** An operation git is in the middle of, or null. */
export function operationInProgress(gitDir) {
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert';
  if (existsSync(join(gitDir, 'BISECT_LOG'))) return 'bisect';
  return null;
}

/**
 * The HEAD reflog, newest first.
 *
 * `sha` is where HEAD pointed *after* the entry's operation, so the state
 * before entry `i` is the sha of entry `i + 1`.
 *
 * @returns {{ index: number, sha: string, subject: string, time: number|null }[]}
 */
export function reflog(cwd, limit = 80) {
  const result = git(
    ['reflog', '--date=unix', `--max-count=${limit}`, `--format=%H${UNIT}%gs${UNIT}%gD`],
    cwd,
  );
  if (result.code !== 0 || !result.stdout) return [];

  return result.stdout.split(/\r?\n/).map((line, index) => {
    const [sha, subject, selector] = line.split(UNIT);
    const stamp = /@\{(\d+)/.exec(selector ?? '');
    return {
      index,
      sha: sha ?? '',
      subject: subject ?? '',
      time: stamp ? Number(stamp[1]) : null,
    };
  });
}

/** The stash entries, newest first. */
export function stashes(cwd) {
  const result = git(['stash', 'list', '--date=unix', `--format=%H${UNIT}%gs${UNIT}%gD`], cwd);
  if (result.code !== 0 || !result.stdout) return [];

  return result.stdout.split(/\r?\n/).map((line, index) => {
    const [sha, subject, selector] = line.split(UNIT);
    const stamp = /@\{(\d+)/.exec(selector ?? '');
    return {
      index,
      sha: sha ?? '',
      subject: subject ?? '',
      time: stamp ? Number(stamp[1]) : null,
    };
  });
}

/** Short form of a sha, as git itself would print it. */
export function short(cwd, sha) {
  if (!sha) return '';
  const result = git(['rev-parse', '--short', sha], cwd);
  return result.code === 0 ? result.stdout : sha.slice(0, 7);
}

/** One-line summary of a commit, or null when it is gone. */
export function describeCommit(cwd, sha) {
  const result = git(['log', '-1', `--format=%h${UNIT}%s${UNIT}%an${UNIT}%ct`, sha], cwd);
  if (result.code !== 0) return null;

  const [abbrev, subject, author, time] = result.stdout.split(UNIT);
  return { sha, abbrev, subject, author, time: Number(time) };
}

/** How many commits are in `range`, e.g. 'a1b2c3..HEAD'. */
export function countCommits(cwd, range) {
  const result = git(['rev-list', '--count', range], cwd);
  return result.code === 0 ? Number(result.stdout) : null;
}

/** Commits that no branch or tag points at any more. */
export function unreachableCommits(cwd, limit = 20) {
  const result = git(['fsck', '--unreachable', '--no-reflogs', '--no-progress'], cwd);
  if (result.code !== 0 && !result.stdout) return [];

  const shas = result.stdout
    .split(/\r?\n/)
    .map((line) => /^unreachable commit ([0-9a-f]{40})/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]);

  return shas
    .map((sha) => describeCommit(cwd, sha))
    .filter(Boolean)
    .sort((a, b) => b.time - a.time)
    .slice(0, limit);
}

export const SEPARATOR = UNIT;
