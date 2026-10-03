import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { relativeTime } from '../src/format.js';
import { cleanup, repoWithHistory } from './repo.js';

after(cleanup);

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'git-undo.js');

function run(cwd, args = []) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('it explains the last commit without touching anything', () => {
  const repo = repoWithHistory();
  const head = repo.head();

  const { code, stdout } = run(repo.dir);

  assert.equal(code, 0);
  assert.match(stdout, /You committed "third"/);
  assert.match(stdout, /git reset --soft/);
  assert.match(stdout, /run it with/);
  assert.equal(repo.head(), head, 'a dry run moves nothing');
});

test('--json gives the whole plan', () => {
  const repo = repoWithHistory();

  const { stdout } = run(repo.dir, ['--json']);
  const payload = JSON.parse(stdout);

  assert.equal(payload.plan.id, 'commit');
  assert.equal(payload.plan.risk, 'safe');
  assert.equal(payload.applied, null);
  assert.equal(payload.repository.branch, 'main');
});

test('--yes runs it and says how to get back', () => {
  const repo = repoWithHistory();
  const head = repo.head();

  const { code, stdout } = run(repo.dir, ['--yes']);

  assert.equal(code, 0);
  assert.match(stdout, /done/);
  assert.match(stdout, /refs\/undo-backup\//);
  assert.notEqual(repo.head(), head, 'this time it really ran');
});

test('a refusal is visible and is not a success', () => {
  const repo = repoWithHistory();
  repo.git('reset', '--hard', 'HEAD~1');
  repo.write('file.txt', 'uncommitted work\n');

  const { code, stdout } = run(repo.dir, ['--yes']);

  assert.equal(code, 1);
  assert.match(stdout, /refused/);
  assert.match(stdout, /git stash -u/);
});

test('outside a repository it exits 2', () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'git-undo-cli-'));

  const { code, stderr } = run(elsewhere);

  assert.equal(code, 2);
  assert.match(stderr, /not a git repository/i);
});

test('list reads back as English', () => {
  const repo = repoWithHistory();

  const { code, stdout } = run(repo.dir, ['list']);

  assert.equal(code, 0);
  assert.match(stdout, /committed "third"/);
  assert.match(stdout, /made the first commit, "first"/);
  assert.match(stdout, /HEAD@\{0\}/);
});

test('list -n limits the output', () => {
  const repo = repoWithHistory();

  const entries = JSON.parse(run(repo.dir, ['list', '-n', '2', '--json']).stdout);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].summary, 'committed "third"');
});

test('lost finds the commits a hard reset dropped', () => {
  const repo = repoWithHistory();
  const dropped = repo.head();
  repo.git('reset', '--hard', 'HEAD~1');

  const { code, stdout } = run(repo.dir, ['lost']);

  assert.equal(code, 0);
  assert.match(stdout, new RegExp(dropped.slice(0, 7)));
  assert.match(stdout, /third/);
  assert.match(stdout, /git branch recovered/);
});

test('backups lists what was saved, newest first', () => {
  const repo = repoWithHistory();

  run(repo.dir, ['--yes']); // undo the last commit; its changes stay staged
  repo.git('commit', '-m', 'third, again');
  run(repo.dir, ['--yes']); // and undo that one too

  const { code, stdout } = run(repo.dir, ['backups']);
  const listed = JSON.parse(run(repo.dir, ['backups', '--json']).stdout);

  assert.equal(code, 0);
  assert.match(stdout, /git reset --hard refs\/undo-backup\//);
  assert.equal(listed.length, 2);
  assert.ok(listed[0].at > listed[1].at, 'newest first');
});

test('an empty repository is handled, not crashed on', () => {
  const repo = repoWithHistory();
  const fresh = mkdtempSync(join(tmpdir(), 'git-undo-empty-'));
  spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: fresh });

  const { code, stdout } = run(fresh);

  assert.equal(code, 1);
  assert.match(stdout, /nothing/i);
  assert.ok(repo.head(), 'unrelated repositories are untouched');
});

test('help and version', () => {
  const repo = repoWithHistory();

  assert.match(run(repo.dir, ['--help']).stdout, /Usage/);
  assert.match(run(repo.dir, ['--version']).stdout, /^\d+\.\d+\.\d+/);
  assert.equal(run(repo.dir, ['nonsense']).code, 2);
});

test('relative time reads naturally', () => {
  const now = 1_800_000_000_000;
  const at = (secondsAgo) => relativeTime(now / 1000 - secondsAgo, now);

  assert.equal(at(2), 'just now');
  assert.equal(at(45), '45 seconds ago');
  assert.equal(at(90), '1 minute ago');
  assert.equal(at(3600), '1 hour ago');
  assert.equal(at(3600 * 5), '5 hours ago');
  assert.equal(at(86400 * 3), '3 days ago');
  assert.equal(at(86400 * 400), '1 year ago');
});
