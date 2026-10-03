import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../src/analyze.js';
import { apply, backups, stamp } from '../src/apply.js';
import { cleanup, repoWithHistory } from './repo.js';

after(cleanup);

test('undoing a commit puts its changes back in the index', () => {
  const repo = repoWithHistory();
  const parent = repo.head('HEAD~1');

  const result = apply(analyze(repo.dir).plan, repo.dir);

  assert.equal(result.ok, true);
  assert.equal(repo.head(), parent, 'HEAD moved back to the parent');
  assert.equal(repo.git('diff', '--cached', '--name-only'), 'file.txt', 'the work is staged, not lost');
});

test('a backup ref is written before anything runs', () => {
  const repo = repoWithHistory();
  const before = repo.head();

  const result = apply(analyze(repo.dir).plan, repo.dir);

  assert.ok(result.backup.startsWith('refs/undo-backup/'));
  assert.equal(repo.git('rev-parse', result.backup), before, 'the backup points at the old HEAD');

  const listed = backups(repo.dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sha, before);
});

test('the backup really does bring everything back', () => {
  const repo = repoWithHistory();
  const before = repo.head();
  const log = repo.git('log', '--format=%s');

  const result = apply(analyze(repo.dir).plan, repo.dir);
  assert.notEqual(repo.head(), before);

  repo.git('reset', '--hard', result.backup);

  assert.equal(repo.head(), before);
  assert.equal(repo.git('log', '--format=%s'), log);
});

test('an undo that would overwrite modified files refuses to run', () => {
  const repo = repoWithHistory();
  repo.git('reset', '--hard', 'HEAD~1');
  const afterReset = repo.head();

  repo.write('file.txt', 'work I have not committed\n');

  const result = apply(analyze(repo.dir).plan, repo.dir);

  assert.equal(result.ok, false);
  assert.equal(result.refused, 'dirty');
  assert.match(result.suggestion, /git stash/);
  assert.equal(repo.head(), afterReset, 'nothing moved');
  assert.equal(repo.git('show', ':file.txt').trim(), 'second', 'the index is untouched');
});

test('--force goes ahead anyway', () => {
  const repo = repoWithHistory();
  const beforeReset = repo.head();
  repo.git('reset', '--hard', 'HEAD~1');
  repo.write('file.txt', 'work I have not committed\n');

  const result = apply(analyze(repo.dir).plan, repo.dir, { force: true });

  assert.equal(result.ok, true);
  assert.equal(repo.head(), beforeReset);
});

test('untracked files are not a reason to refuse', () => {
  const repo = repoWithHistory();
  const beforeReset = repo.head();
  repo.git('reset', '--hard', 'HEAD~1');
  repo.write('brand-new.txt', 'untracked\n');

  const result = apply(analyze(repo.dir).plan, repo.dir);

  assert.equal(result.ok, true, 'a hard reset leaves untracked files alone');
  assert.equal(repo.head(), beforeReset);
});

test('aborting a conflicted merge leaves a clean tree', () => {
  const repo = repoWithHistory();
  repo.git('checkout', '-q', '-b', 'other', 'HEAD~1');
  repo.commit('theirs', { 'file.txt': 'theirs' });
  repo.git('checkout', '-q', 'main');
  const before = repo.head();

  assert.notEqual(repo.tryGit('merge', 'other').code, 0, 'the merge was supposed to conflict');

  const result = apply(analyze(repo.dir).plan, repo.dir);

  assert.equal(result.ok, true);
  assert.equal(repo.head(), before);
  assert.equal(repo.git('status', '--porcelain'), '', 'the working tree is clean again');
});

test('popping a stash brings the work back', () => {
  const repo = repoWithHistory();
  repo.write('file.txt', 'work in progress\n');
  repo.git('stash', 'push', '-m', 'wip');
  assert.equal(repo.git('status', '--porcelain'), '', 'the stash took the change away');

  const result = apply(analyze(repo.dir).plan, repo.dir);

  assert.equal(result.ok, true);
  assert.match(repo.git('status', '--porcelain'), /file\.txt/, 'the change is back');
  assert.equal(repo.git('stash', 'list'), '', 'and the stash entry is gone');
});

test('a rebase is undone in one go', () => {
  const repo = repoWithHistory();
  repo.git('checkout', '-q', '-b', 'topic', 'HEAD~2');
  repo.commit('topic work', { 'topic.txt': 'work' });
  const beforeRebase = repo.head();
  const tree = repo.git('rev-parse', 'HEAD^{tree}');

  repo.git('rebase', 'main');
  assert.notEqual(repo.head(), beforeRebase, 'the rebase rewrote the commit');

  const result = apply(analyze(repo.dir).plan, repo.dir);

  assert.equal(result.ok, true);
  assert.equal(repo.head(), beforeRebase, 'back on the original commit');
  assert.equal(repo.git('rev-parse', 'HEAD^{tree}'), tree, 'with the original files');
});

test('backup refs are named so they sort by date', () => {
  const first = stamp(new Date('2026-01-02T03:04:05.678Z'));
  const second = stamp(new Date('2026-01-02T03:04:06.000Z'));

  assert.equal(first, '2026-01-02T03-04-05-678Z');
  assert.ok(second > first);
  assert.doesNotMatch(first, /[:.~^?*[\]\\ ]/, 'a ref name cannot contain those');
});
