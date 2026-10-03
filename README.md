# git undo

**English** · [Français](README.fr.md)

**You just did something to your repository. This tells you how to take it
back.** It reads your reflog, works out what the last operation actually was,
and prints the exact command that reverses it — in plain language, with the
risk spelled out.

[![CI](https://github.com/CedricPoint/git-undo/actions/workflows/ci.yml/badge.svg)](https://github.com/CedricPoint/git-undo/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

```console
$ git undo

  git undo  ·  main

  You committed "add rate limiting to the API".  just now

  undo with   git reset --soft 73318d2
  it will     remove the commit and put its changes back in your staging area, untouched.
  risk        safe · nothing is thrown away

  run it with git undo --yes
```

It knows the difference between a commit, an amend, a reset, a merge, a rebase
and a stash — which matters, because the command that undoes each one is
different, and getting it wrong is how people lose an afternoon.

```console
$ git undo

  git undo  ·  hotfix

  You reset to HEAD~1.  just now

  undo with   git reset --hard abe706e
  it will     move the branch back to abe706e and restore every file to that state, 1 commit comes back.
  risk        destructive · files and commits are rewritten

  run it with git undo --yes
              a backup ref is written first, so this stays reversible
```

## Install

```bash
# one off, nothing installed
npx github:CedricPoint/git-undo

# or put it on your PATH, and git picks it up as a subcommand
npm install -g github:CedricPoint/git-undo
git undo
```

Node 18 or newer, and git. No dependencies, no config file, no hooks, nothing
to initialise in your repository.

## What it understands

| you just did | it proposes | risk |
| --- | --- | --- |
| a commit | `git reset --soft <parent>` | safe |
| your first commit ever | `git update-ref -d HEAD` | careful |
| `--amend` | `git reset --soft <before>` | safe |
| a reset | `git reset --hard <before>` | destructive |
| a merge | `git reset --hard <before>` | destructive |
| a pull (merge or rebase) | `git reset --hard <before>` | destructive |
| a rebase | `git reset --hard <before the whole rebase>` | destructive |
| a cherry-pick | `git reset --hard <before the run>` | destructive |
| a revert | `git reset --hard <before>` | destructive |
| switched branch | `git checkout <where you were>` | safe |
| `git stash` | `git stash pop` | careful |
| a merge/rebase/cherry-pick that conflicted | `git <that> --abort` | safe |

Multi-step operations are treated as one thing: undoing a rebase of four
commits goes back to where you were before the rebase, not back one pick.

A stash is the sneaky one — `git stash` writes `reset: moving to HEAD` in the
reflog and moves nothing, so a naive reading of the reflog proposes a reset.
This checks the stash log and tells you to pop instead.

## It does not run anything unless you say so

- **Dry run by default.** Plain `git undo` only ever reads.
- **A backup before every change.** `--yes` writes where HEAD is to
  `refs/undo-backup/<timestamp>` before it touches anything, and prints the one
  command that puts it all back. Nothing can be garbage collected behind your
  back.
- **It refuses to overwrite work.** If a `--hard` is involved and you have
  modified files, it stops and tells you to commit or stash first. `--force` is
  there when you mean it. Untracked files are never a reason to refuse — a hard
  reset does not touch them.

```console
  refused     1 file in your working tree is modified, and this undo would overwrite it.
              Commit them, or run git stash -u first. Use --force to go ahead anyway.
```

## The rest of the commands

```bash
git undo list       # the reflog, in English
git undo lost       # commits no branch points at any more
git undo backups    # every safety ref git undo has written
```

```console
$ git undo list

  recent history

  HEAD@{0}   just now         reset to HEAD~1
  HEAD@{1}   2 minutes ago    committed "add rate limiting to the API"
  HEAD@{2}   9 minutes ago    switched from main to hotfix
  HEAD@{3}   9 minutes ago    made the first commit, "set up the API"
```

`git undo lost` is the one to reach for when commits have genuinely
disappeared: it lists the dangling ones with their subject and age, and the
command to put a branch back on any of them.

Every command takes `--json`, so this works inside your own scripts:

```bash
git undo --json | jq -r '.plan.command | join(" ")'
```

```js
import { analyze, apply } from 'git-undo';

const { plan } = analyze();
if (plan?.risk === 'safe') apply(plan);
```

## Why not just an alias

`git undo` as an alias for `git reset --soft HEAD~1` is the common trick, and
it is wrong most of the time: it mangles a merge, it does nothing useful after
a rebase, and it silently discards a conflicted state. The whole value here is
reading what actually happened first.

## Tests

37 of them, and they are not mocks — each one builds a real repository in a
temp directory, runs real git commands (including the ones that conflict), and
checks the plan against what git actually wrote in the reflog:

```bash
npm test
```

```
ok   a rebase is undone as one operation, not one commit at a time
ok   a stash is recognised, even though git logs it as a reset
ok   an undo that would overwrite modified files refuses to run
ok   the backup really does bring everything back
ok   untracked files are not a reason to refuse
```

They run on Linux, macOS and Windows against Node 18, 20 and 22.

## License

MIT
