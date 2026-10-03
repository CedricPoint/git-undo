/**
 * The brain: repository state plus reflog in, one undo plan out.
 *
 * A plan is deliberately boring data — the command and a plain-language
 * description of what it does. Nothing here runs anything.
 */

import { countCommits, reflog, repository, short, stashes } from './git.js';

/**
 * @typedef {object} Plan
 * @property {string} id              stable identifier, e.g. 'commit' or 'abort.merge'
 * @property {string} what            what the user did, in plain language
 * @property {string[]} command       git arguments
 * @property {string} effect          what running it will do
 * @property {'safe'|'careful'|'destructive'} risk
 * @property {string[]} warnings
 * @property {boolean} needsCleanTree refuse while tracked files are modified
 * @property {string|null} restoresTo the commit HEAD will point at afterwards
 * @property {number|null} at         when the undone operation happened
 */

const ABORTS = {
  rebase: {
    id: 'abort.rebase',
    what: 'A rebase is in progress.',
    command: ['rebase', '--abort'],
    effect: 'put the branch and the working tree back exactly as they were before the rebase started.',
  },
  merge: {
    id: 'abort.merge',
    what: 'A merge is in progress.',
    command: ['merge', '--abort'],
    effect: 'cancel the merge and restore the working tree as it was before it.',
  },
  'cherry-pick': {
    id: 'abort.cherry-pick',
    what: 'A cherry-pick is in progress.',
    command: ['cherry-pick', '--abort'],
    effect: 'cancel the cherry-pick and restore the working tree as it was before it.',
  },
  revert: {
    id: 'abort.revert',
    what: 'A revert is in progress.',
    command: ['revert', '--abort'],
    effect: 'cancel the revert and restore the working tree as it was before it.',
  },
  bisect: {
    id: 'abort.bisect',
    what: 'A bisect session is running.',
    command: ['bisect', 'reset'],
    effect: 'end the session and return to the commit you started from.',
  },
};

/**
 * Work out what the last thing to happen was, and how to undo it.
 *
 * @param {string} [cwd]
 * @returns {{ repository: object|null, entries: object[], plan: Plan|null, reason: string|null }}
 */
export function analyze(cwd = process.cwd()) {
  const repo = repository(cwd);
  if (!repo) {
    return { repository: null, entries: [], plan: null, reason: 'This is not a git repository.' };
  }

  const entries = reflog(cwd);

  if (repo.operation) {
    const abort = ABORTS[repo.operation];
    return {
      repository: repo,
      entries,
      plan: { ...abort, risk: 'safe', warnings: [], needsCleanTree: false, restoresTo: null, at: null },
      reason: null,
    };
  }

  if (!entries.length) {
    return {
      repository: repo,
      entries,
      plan: null,
      reason: 'Nothing has happened in this repository yet — the reflog is empty.',
    };
  }

  const built = build(cwd, repo, entries);
  return { repository: repo, entries, plan: built.plan, reason: built.reason };
}

/* ------------------------------------------------------------------ plans */

function build(cwd, repo, entries) {
  const latest = entries[0];
  const previous = entries[1] ?? null;
  const subject = latest.subject;

  const stashed = stashPlan(cwd, entries);
  if (stashed) return { plan: stashed, reason: null };

  if (/^commit \(initial\):/.test(subject)) {
    return {
      plan: {
        id: 'commit.initial',
        what: `You made the first commit of this repository (${quote(subject)}).`,
        command: ['update-ref', '-d', 'HEAD'],
        effect: 'remove the commit and leave every file staged, as if you had only run git add.',
        risk: 'careful',
        warnings: ['The branch will not exist again until you commit.'],
        needsCleanTree: false,
        restoresTo: null,
        at: latest.time,
      },
      reason: null,
    };
  }

  if (/^commit \(amend\):/.test(subject) && previous) {
    return {
      plan: {
        id: 'commit.amend',
        what: `You amended the previous commit (${quote(subject)}).`,
        command: ['reset', '--soft', short(cwd, previous.sha)],
        effect:
          'bring back the commit as it was before the amend, with everything you added staged and ready.',
        risk: 'safe',
        warnings: [],
        needsCleanTree: false,
        restoresTo: previous.sha,
        at: latest.time,
      },
      reason: null,
    };
  }

  if (/^commit:/.test(subject) && previous) {
    return {
      plan: {
        id: 'commit',
        what: `You committed ${quote(subject)}.`,
        command: ['reset', '--soft', short(cwd, previous.sha)],
        effect: 'remove the commit and put its changes back in your staging area, untouched.',
        risk: 'safe',
        warnings: [],
        needsCleanTree: false,
        restoresTo: previous.sha,
        at: latest.time,
      },
      reason: null,
    };
  }

  if (/^reset:/.test(subject) && previous) {
    const target = subject.replace(/^reset: moving to /, '');
    return {
      plan: {
        id: 'reset',
        what: `You reset to ${target}.`,
        command: ['reset', '--hard', short(cwd, previous.sha)],
        effect: restoreEffect(cwd, previous.sha, 'the branch'),
        risk: 'destructive',
        warnings: [],
        needsCleanTree: true,
        restoresTo: previous.sha,
        at: latest.time,
      },
      reason: null,
    };
  }

  if (/^merge /.test(subject) && previous) {
    const branch = /^merge ([^:]+):/.exec(subject);
    return {
      plan: {
        id: 'merge',
        what: `You merged ${branch ? branch[1] : 'a branch'}.`,
        command: ['reset', '--hard', short(cwd, previous.sha)],
        effect: restoreEffect(cwd, previous.sha, 'the branch'),
        risk: 'destructive',
        warnings: [pushedWarning('merge')],
        needsCleanTree: true,
        restoresTo: previous.sha,
        at: latest.time,
      },
      reason: null,
    };
  }

  // A rebasing pull writes a run of `pull (start|pick|finish)` entries.
  if (/^pull \(/.test(subject)) {
    return sequencePlan(cwd, entries, /^pull \(/, {
      id: 'pull.rebase',
      what: 'You pulled, and your commits were rebased on top.',
    });
  }

  if (/^pull/.test(subject) && previous) {
    return {
      plan: {
        id: 'pull',
        what: 'You pulled.',
        command: ['reset', '--hard', short(cwd, previous.sha)],
        effect: restoreEffect(cwd, previous.sha, 'the branch'),
        risk: 'destructive',
        warnings: ['The commits you pulled stay on the remote; this only moves your branch back.'],
        needsCleanTree: true,
        restoresTo: previous.sha,
        at: latest.time,
      },
      reason: null,
    };
  }

  if (/^rebase\b/.test(subject)) {
    const onto = /^rebase \(start\): checkout (.+)$/.exec(entries.find((e) => /^rebase \(start\)/.test(e.subject))?.subject ?? '');
    return sequencePlan(cwd, entries, /^rebase\b/, {
      id: 'rebase',
      what: onto ? `You rebased onto ${onto[1]}.` : 'You rebased.',
      warnings: [pushedWarning('rebase')],
    });
  }

  if (/^cherry-pick/.test(subject)) {
    return sequencePlan(cwd, entries, /^cherry-pick/, {
      id: 'cherry-pick',
      what: `You cherry-picked ${quote(subject)}.`,
    });
  }

  if (/^revert:/.test(subject) && previous) {
    return {
      plan: {
        id: 'revert',
        what: `You reverted a commit (${quote(subject)}).`,
        command: ['reset', '--hard', short(cwd, previous.sha)],
        effect: restoreEffect(cwd, previous.sha, 'the branch'),
        risk: 'destructive',
        warnings: ['If the revert is already pushed, revert the revert instead of moving the branch.'],
        needsCleanTree: true,
        restoresTo: previous.sha,
        at: latest.time,
      },
      reason: null,
    };
  }

  const switched = /^checkout: moving from (.+) to (.+)$/.exec(subject);
  if (switched) {
    const [, from, to] = switched;
    return {
      plan: {
        id: 'checkout',
        what: `You switched from ${from} to ${to}.`,
        command: ['checkout', from],
        effect: `switch back to ${from}. Your files and commits are not touched.`,
        risk: 'safe',
        warnings: /^[0-9a-f]{7,40}$/.test(from)
          ? [`${from} is a commit, not a branch, so you will end up with a detached HEAD.`]
          : [],
        needsCleanTree: false,
        restoresTo: null,
        at: latest.time,
      },
      reason: null,
    };
  }

  if (/^clone:/.test(subject)) {
    return { plan: null, reason: 'This repository was just cloned. There is nothing to undo inside it.' };
  }

  if (!previous) {
    return { plan: null, reason: `The only thing in the reflog is "${subject}", so there is nothing to go back to.` };
  }

  return {
    plan: {
      id: 'unknown',
      what: `The last thing in the reflog is "${subject}", which I do not recognise.`,
      command: ['reset', '--hard', short(cwd, previous.sha)],
      effect: restoreEffect(cwd, previous.sha, 'the branch'),
      risk: 'destructive',
      warnings: ['This is a generic guess. Read it twice before running it.'],
      needsCleanTree: true,
      restoresTo: previous.sha,
      at: latest.time,
    },
    reason: null,
  };
}

/**
 * Operations that write several reflog entries — a rebase, a rebasing pull, a
 * run of cherry-picks — are undone by going back to the state before the whole
 * run, which is the entry just after it.
 */
function sequencePlan(cwd, entries, pattern, plan) {
  let length = 0;
  while (length < entries.length && pattern.test(entries[length].subject)) length += 1;

  const before = entries[length];
  if (!before) {
    return {
      plan: null,
      reason: 'The reflog does not go back far enough to find the state before that operation.',
    };
  }

  return {
    plan: {
      warnings: [],
      ...plan,
      command: ['reset', '--hard', short(cwd, before.sha)],
      effect: restoreEffect(cwd, before.sha, 'the branch'),
      risk: 'destructive',
      needsCleanTree: true,
      restoresTo: before.sha,
      at: entries[0].time,
    },
    reason: null,
  };
}

/**
 * The stash is the one operation that leaves a misleading trail: `git stash`
 * writes `reset: moving to HEAD` in the HEAD reflog without moving anything.
 * A stash entry created at the same moment is what gives it away.
 */
function stashPlan(cwd, entries) {
  const latest = entries[0];
  if (latest.subject !== 'reset: moving to HEAD') return null;
  if (entries[1] && entries[1].sha !== latest.sha) return null;

  const stash = stashes(cwd)[0];
  if (!stash || !stash.time || !latest.time) return null;
  if (Math.abs(stash.time - latest.time) > 5) return null;

  return {
    id: 'stash',
    what: `You stashed your changes (${stash.subject}).`,
    command: ['stash', 'pop'],
    effect: 'put the stashed changes back in your working tree and drop the stash entry.',
    risk: 'careful',
    warnings: ['If you have changed the same lines since, popping can conflict.'],
    needsCleanTree: false,
    restoresTo: null,
    at: latest.time,
  };
}

/* ------------------------------------------------------------------ pieces */

function restoreEffect(cwd, sha, what) {
  const abbrev = short(cwd, sha);
  const lost = countCommits(cwd, `${sha}..HEAD`);
  const regained = countCommits(cwd, `HEAD..${sha}`);

  const parts = [`move ${what} back to ${abbrev} and restore every file to that state`];
  if (regained) parts.push(`${plural(regained, 'commit')} ${regained === 1 ? 'comes' : 'come'} back`);
  if (lost) parts.push(`${plural(lost, 'commit')} ${lost === 1 ? 'stops' : 'stop'} being on this branch`);

  return `${parts.join(', ')}.`;
}

function pushedWarning(operation) {
  return `If you have already pushed this ${operation}, moving the branch back will not match the remote.`;
}

function quote(subject) {
  const text = subject.replace(/^[^:]+:\s*/, '');
  return `"${text.length > 60 ? `${text.slice(0, 59)}…` : text}"`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * One line of plain language for a reflog entry, used by `git undo list`.
 */
export function summarize(subject) {
  const rules = [
    [/^commit \(initial\): (.*)$/, (m) => `made the first commit, "${m[1]}"`],
    [/^commit \(amend\): (.*)$/, (m) => `amended the last commit, now "${m[1]}"`],
    [/^commit: (.*)$/, (m) => `committed "${m[1]}"`],
    [/^reset: moving to (.*)$/, (m) => `reset to ${m[1]}`],
    [/^merge ([^:]+): (.*)$/, (m) => `merged ${m[1]} (${m[2].replace(/\.$/, '')})`],
    [/^checkout: moving from (.+) to (.+)$/, (m) => `switched from ${m[1]} to ${m[2]}`],
    [/^rebase \(start\): checkout (.*)$/, (m) => `started a rebase onto ${m[1]}`],
    [/^rebase \(finish\).*$/, () => 'finished the rebase'],
    [/^rebase \(([^)]+)\): (.*)$/, (m) => `rebase, ${m[1]}: "${m[2]}"`],
    [/^pull \(start\).*$/, () => 'started a rebasing pull'],
    [/^pull \(finish\).*$/, () => 'finished the pull'],
    [/^pull \(([^)]+)\): (.*)$/, (m) => `pull, ${m[1]}: "${m[2]}"`],
    [/^pull.*: (.*)$/, (m) => `pulled (${m[1].replace(/\.$/, '')})`],
    [/^cherry-pick: (.*)$/, (m) => `cherry-picked "${m[1]}"`],
    [/^revert: (.*)$/, (m) => `reverted, "${m[1]}"`],
    [/^clone: from (.*)$/, (m) => `cloned from ${m[1]}`],
    [/^branch: Created from (.*)$/, (m) => `created the branch from ${m[1]}`],
  ];

  for (const [pattern, render] of rules) {
    const match = pattern.exec(subject);
    if (match) return render(match);
  }

  return subject;
}
