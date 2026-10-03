/**
 * Programmatic API.
 *
 *   import { analyze, apply } from 'git-undo';
 *
 *   const { plan } = analyze();
 *   if (plan && plan.risk === 'safe') apply(plan);
 */

export { analyze, summarize } from './analyze.js';
export { apply, backups, BACKUP_NAMESPACE } from './apply.js';
export { repository, reflog, stashes, unreachableCommits, GitError } from './git.js';
export { commandLine, relativeTime } from './format.js';
