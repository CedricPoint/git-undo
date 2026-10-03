import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze, summarize } from '../src/analyze.js';
import { cleanup, makeRepo, repoWithHistory } from './repo.js';

after(cleanup);

test('outside a repository it says so', () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'git-undo-nowhere-'));
  const { plan, reason } = analyze(elsewhere);

  assert.equal(plan, null);
  assert.match(reason, /not a git repository/i);
});

test('a brand new repository has nothing to undo', () => {
  const repo = makeRepo();
  const { plan, reason } = analyze(repo.dir);

  assert.equal(plan, null);
  assert.match(reason, /reflog is empty/i);
});

test('a commit is undone by a soft reset to its parent', () => {
  const repo = repoWithHistory();
  const parent = repo.git('rev-parse', '--short', 'HEAD~1');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'commit');
  assert.match(plan.what, /You committed "third"/);
  assert.deepEqual(plan.command, ['reset', '--soft', parent]);
  assert.equal(plan.risk, 'safe');
  assert.equal(plan.needsCleanTree, false);
});

test('the very first commit is undone without a parent to reset to', () => {
  const repo = makeRepo();
  repo.commit('first');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'commit.initial');
  assert.deepEqual(plan.command, ['update-ref', '-d', 'HEAD']);
  assert.equal(plan.needsCleanTree, false);
});

test('an amend is undone by going back to the commit before it', () => {
  const repo = repoWithHistory();
  const beforeAmend = repo.git('rev-parse', '--short', 'HEAD');

  repo.write('file.txt', 'amended\n');
  repo.git('add', '-A');
  repo.git('commit', '--amend', '-m', 'third, but better');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'commit.amend');
  assert.deepEqual(plan.command, ['reset', '--soft', beforeAmend]);
  assert.equal(plan.risk, 'safe');
});

test('a hard reset is undone by going back, and is flagged destructive', () => {
  const repo = repoWithHistory();
  const beforeReset = repo.head();
  const beforeResetShort = repo.git('rev-parse', '--short', 'HEAD');

  repo.git('reset', '--hard', 'HEAD~2');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'reset');
  assert.deepEqual(plan.command, ['reset', '--hard', beforeResetShort]);
  assert.equal(plan.risk, 'destructive');
  assert.equal(plan.needsCleanTree, true);
  assert.equal(plan.restoresTo, beforeReset);
  assert.match(plan.effect, /2 commits come back/);
});

test('a merge is undone by going back to the commit before it', () => {
  const repo = repoWithHistory();
  repo.git('checkout', '-q', '-b', 'feature');
  repo.commit('feature work', { 'feature.txt': 'work' });
  repo.git('checkout', '-q', 'main');
  const beforeMerge = repo.git('rev-parse', '--short', 'HEAD');
  repo.git('merge', '--no-ff', '-m', 'merge feature', 'feature');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'merge');
  assert.match(plan.what, /You merged feature/);
  assert.deepEqual(plan.command, ['reset', '--hard', beforeMerge]);
  assert.ok(plan.warnings.some((w) => /already pushed/.test(w)));
});

test('a rebase is undone as one operation, not one commit at a time', () => {
  const repo = repoWithHistory();
  repo.git('checkout', '-q', '-b', 'topic', 'HEAD~2');
  repo.commit('topic work', { 'topic.txt': 'work' });
  const beforeRebase = repo.git('rev-parse', '--short', 'HEAD');

  repo.git('rebase', 'main');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'rebase');
  assert.match(plan.what, /rebased onto main/);
  assert.deepEqual(plan.command, ['reset', '--hard', beforeRebase]);
  assert.equal(plan.needsCleanTree, true);
});

test('a cherry-pick is undone', () => {
  const repo = repoWithHistory();
  repo.git('checkout', '-q', '-b', 'topic', 'HEAD~2');
  repo.commit('topic work', { 'topic.txt': 'work' });
  repo.git('checkout', '-q', 'main');
  const beforePick = repo.git('rev-parse', '--short', 'HEAD');

  repo.git('cherry-pick', 'topic');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'cherry-pick');
  assert.deepEqual(plan.command, ['reset', '--hard', beforePick]);
});

test('a revert is undone', () => {
  const repo = repoWithHistory();
  const beforeRevert = repo.git('rev-parse', '--short', 'HEAD');

  repo.git('revert', '--no-edit', 'HEAD');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'revert');
  assert.deepEqual(plan.command, ['reset', '--hard', beforeRevert]);
});

test('switching branches is undone by switching back, and is safe', () => {
  const repo = repoWithHistory();
  repo.git('checkout', '-q', '-b', 'feature');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'checkout');
  assert.deepEqual(plan.command, ['checkout', 'main']);
  assert.equal(plan.risk, 'safe');
  assert.equal(plan.needsCleanTree, false);
});

test('a stash is recognised, even though git logs it as a reset', () => {
  const repo = repoWithHistory();
  repo.write('file.txt', 'work in progress\n');
  repo.git('stash', 'push', '-m', 'wip');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'stash');
  assert.deepEqual(plan.command, ['stash', 'pop']);
  assert.equal(plan.risk, 'careful');
});

test('a conflicted merge is aborted rather than reset', () => {
  const repo = makeRepo();
  repo.commit('first', { 'conflict.txt': 'base' });
  repo.git('checkout', '-q', '-b', 'other');
  repo.commit('theirs', { 'conflict.txt': 'theirs' });
  repo.git('checkout', '-q', 'main');
  repo.commit('ours', { 'conflict.txt': 'ours' });

  const merge = repo.tryGit('merge', 'other');
  assert.notEqual(merge.code, 0, 'the merge was supposed to conflict');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'abort.merge');
  assert.deepEqual(plan.command, ['merge', '--abort']);
  assert.equal(plan.risk, 'safe');
});

test('a conflicted rebase is aborted rather than reset', () => {
  const repo = makeRepo();
  repo.commit('first', { 'conflict.txt': 'base' });
  repo.git('checkout', '-q', '-b', 'other');
  repo.commit('theirs', { 'conflict.txt': 'theirs' });
  repo.git('checkout', '-q', 'main');
  repo.commit('ours', { 'conflict.txt': 'ours' });

  const rebase = repo.tryGit('rebase', 'other');
  assert.notEqual(rebase.code, 0, 'the rebase was supposed to conflict');

  const { plan } = analyze(repo.dir);

  assert.equal(plan.id, 'abort.rebase');
  assert.deepEqual(plan.command, ['rebase', '--abort']);
});

test('the reflog is turned into plain language', () => {
  assert.equal(summarize('commit: add rate limiting'), 'committed "add rate limiting"');
  assert.equal(summarize('commit (amend): fix typo'), 'amended the last commit, now "fix typo"');
  assert.equal(summarize('reset: moving to HEAD~1'), 'reset to HEAD~1');
  assert.equal(summarize('checkout: moving from main to feature'), 'switched from main to feature');
  assert.equal(summarize('merge feature: Fast-forward'), 'merged feature (Fast-forward)');
  assert.equal(summarize('rebase (start): checkout main'), 'started a rebase onto main');
  assert.equal(summarize('something new in git 42'), 'something new in git 42');
});
