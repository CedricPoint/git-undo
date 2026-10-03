/**
 * Throwaway git repositories for the tests.
 *
 * These are real repositories driven by the real git binary — the tests would
 * be worthless otherwise, since the whole tool is an opinion about what git
 * writes in the reflog.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = [];

/** User config, signing and hooks are kept out of the way. */
function environment(dir) {
  return {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_GLOBAL: join(dir, 'absent-global-config'),
    GIT_CONFIG_SYSTEM: join(dir, 'absent-system-config'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'git-undo-test-'));
  created.push(dir);

  const repo = {
    dir,

    /** Run git, and fail loudly if it did not work. */
    git(...args) {
      const result = spawnSync(
        'git',
        ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(dir, 'no-hooks')}`, ...args],
        { cwd: dir, encoding: 'utf8', env: environment(dir) },
      );
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
      }
      return (result.stdout ?? '').trim();
    },

    /** Run git and return the result, failure included. */
    tryGit(...args) {
      const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: environment(dir),
      });
      return { code: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
    },

    write(name, content) {
      writeFileSync(join(dir, name), content, 'utf8');
      return repo;
    },

    commit(message, files = { 'file.txt': message }) {
      for (const [name, content] of Object.entries(files)) repo.write(name, `${content}\n`);
      repo.git('add', '-A');
      repo.git('commit', '-m', message);
      return repo.head();
    },

    head(ref = 'HEAD') {
      return repo.git('rev-parse', ref);
    },

    subject(ref = 'HEAD') {
      return repo.git('log', '-1', '--format=%s', ref);
    },

    branch() {
      return repo.git('symbolic-ref', '--short', 'HEAD');
    },
  };

  mkdirSync(join(dir, 'absent'), { recursive: true });
  repo.git('init', '-q', '-b', 'main', '.');

  // Written into the repository's own config, not just the environment: the
  // fixture and the tool under test run git separately, and on Windows the
  // system config turns line-ending conversion on. Without this they would
  // disagree about what is in the working tree.
  repo.git('config', 'core.autocrlf', 'false');

  return repo;
}

/** A repository with three commits on main. */
export function repoWithHistory() {
  const repo = makeRepo();
  repo.commit('first');
  repo.commit('second');
  repo.commit('third');
  return repo;
}

export function cleanup() {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover temp directory is not worth failing a test run over.
    }
  }
}
