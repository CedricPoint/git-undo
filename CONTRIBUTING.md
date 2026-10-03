# Contributing

The most useful contribution is a situation this gets wrong: a reflog entry it
misreads, or an operation it does not know about yet. Paste the output of
`git undo list` from the repository where it happened and that is enough to
work from.

## Getting started

```bash
git clone https://github.com/CedricPoint/git-undo.git
cd git-undo
npm test                 # no install step: there are no dependencies
node bin/git-undo.js     # try it on this very repository
```

## How it fits together

| file | what it does |
| --- | --- |
| `src/git.js` | runs git and reads the repository. Decides nothing. |
| `src/analyze.js` | reflog in, one plan out. The opinions live here. |
| `src/apply.js` | the guard rails and the backup ref. |
| `src/format.js` | everything the user reads. |
| `bin/git-undo.js` | argument parsing and exit codes. |

A plan is plain data:

```js
{
  id: 'rebase',
  what: 'You rebased onto main.',          // what the user did
  command: ['reset', '--hard', 'abe706e'], // git arguments
  effect: 'move the branch back to …',     // reads after "it will"
  risk: 'destructive',                     // safe | careful | destructive
  warnings: [],
  needsCleanTree: true,
  restoresTo: '<full sha>',
}
```

## Adding support for an operation

1. Find out what git really writes. Do the operation in a scratch repository
   and look: `git reflog --date=unix --format='%gD | %gs'`. Do not trust
   memory — the wording differs between operations and between versions.
2. Add the branch in `build()` in `src/analyze.js`. If the operation writes
   several reflog entries (rebase, rebasing pull, a run of cherry-picks), use
   `sequencePlan`, which goes back to the state before the whole run.
3. Add a test that performs the operation for real.

## Tests

They build real repositories in temp directories and drive the real git
binary — that is the only way to be sure, since this tool is entirely an
opinion about what git writes down. `test/repo.js` has the helpers:

```js
const repo = repoWithHistory();          // three commits on main
repo.git('rebase', 'main');              // do the thing
const { plan } = analyze(repo.dir);      // check what we would propose
```

Keep every assertion about behaviour, not about wording, so the copy can be
improved without breaking the suite.

## Style

Plain ESM, no dependencies, no build step. `npx` has to stay instant, and
somebody worried about what this tool will do to their repository should be
able to read all of it in one sitting.
