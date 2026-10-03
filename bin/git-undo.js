#!/usr/bin/env node
/**
 * git-undo — tells you how to undo the last thing you did in git.
 *
 * Named `git-undo` so that git itself picks it up: once it is on your PATH,
 * `git undo` works like any built-in subcommand.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyze, summarize } from '../src/analyze.js';
import { apply, backups } from '../src/apply.js';
import { unreachableCommits, GitError } from '../src/git.js';
import { color, renderBackups, renderList, renderLost, renderPlan } from '../src/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const EXIT = { ok: 0, nothing: 1, error: 2 };

const HELP = `
  ${color.bold('git undo')} — how to undo the last thing you did

  ${color.bold('Usage')}
    git undo               Say what just happened and how to undo it
    git undo --yes         Actually do it, after writing a backup ref
    git undo list          The recent history, in plain language
    git undo lost          Commits no branch points at any more
    git undo backups       Every safety ref git undo has written

  ${color.bold('Options')}
    -y, --yes       Run the command instead of only printing it
        --force     Run it even with modified files in the way
        --json      Machine-readable output
    -n <count>      How many entries \`list\` shows (default 15)
    -h, --help      This text
    -v, --version   Print the version

  ${color.bold('Exit codes')}
    0  something to undo (or the undo ran)
    1  nothing to undo
    2  not a git repository, or git failed

  Nothing is executed unless you pass --yes, and even then the position of
  HEAD is saved to refs/undo-backup/ before anything runs.
`;

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof GitError ? error.message : `${error.message}`;
    process.stderr.write(`git undo: ${message}\n`);
    process.exitCode = EXIT.error;
  });

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }
  if (flags.version) {
    process.stdout.write(`${pkg.version}\n`);
    return EXIT.ok;
  }

  switch (positionals[0]) {
    case 'list':
      return listCommand(flags);
    case 'lost':
      return lostCommand(flags);
    case 'backups':
      return backupsCommand(flags);
    case undefined:
      return undoCommand(flags);
    default:
      process.stderr.write(`git undo: unknown command "${positionals[0]}". Try git undo --help.\n`);
      return EXIT.error;
  }
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') flags.help = true;
    else if (arg === '-v' || arg === '--version') flags.version = true;
    else if (arg === '-y' || arg === '--yes') flags.yes = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '-n') flags.count = Number(argv[++i]);
    else if (arg.startsWith('-n')) flags.count = Number(arg.slice(2));
    else positionals.push(arg);
  }

  return { flags, positionals };
}

function undoCommand(flags) {
  const analysis = analyze();

  if (!analysis.repository) {
    if (flags.json) process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
    else process.stderr.write(`git undo: ${analysis.reason}\n`);
    return EXIT.error;
  }

  const applied = flags.yes && analysis.plan ? apply(analysis.plan, process.cwd(), { force: flags.force }) : null;

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...analysis, applied }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderPlan(analysis, { applied })}\n`);
  }

  if (!analysis.plan) return EXIT.nothing;
  if (applied && !applied.ok) return EXIT.nothing;
  return EXIT.ok;
}

function listCommand(flags) {
  const analysis = analyze();
  if (!analysis.repository) {
    process.stderr.write(`git undo: ${analysis.reason}\n`);
    return EXIT.error;
  }

  const entries = analysis.entries.slice(0, Number.isFinite(flags.count) ? flags.count : 15);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(entries.map((e) => ({ ...e, summary: summarize(e.subject) })), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderList(entries, summarize)}\n`);
  }

  return entries.length ? EXIT.ok : EXIT.nothing;
}

function lostCommand(flags) {
  const commits = unreachableCommits(process.cwd());

  if (flags.json) process.stdout.write(`${JSON.stringify(commits, null, 2)}\n`);
  else process.stdout.write(`${renderLost(commits)}\n`);

  return commits.length ? EXIT.ok : EXIT.nothing;
}

function backupsCommand(flags) {
  const refs = backups(process.cwd());

  if (flags.json) process.stdout.write(`${JSON.stringify(refs, null, 2)}\n`);
  else process.stdout.write(`${renderBackups(refs)}\n`);

  return refs.length ? EXIT.ok : EXIT.nothing;
}
