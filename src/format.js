/**
 * Everything the user reads.
 */

const colorEnabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  (process.env.FORCE_COLOR !== undefined || Boolean(process.stdout.isTTY));

const wrap = (open, close) => (text) => (colorEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : String(text));

export const color = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  grey: wrap(90, 39),
};

const RISK = {
  safe: () => color.green('safe') + color.grey(' · nothing is thrown away'),
  careful: () => color.yellow('careful') + color.grey(' · read the note below first'),
  destructive: () => color.red('destructive') + color.grey(' · files and commits are rewritten'),
};

/** `git reset --soft a1b2c3d` */
export function commandLine(plan) {
  return `git ${plan.command.join(' ')}`;
}

/** The main screen: what happened, and how to undo it. */
export function renderPlan(analysis, { applied = null } = {}) {
  const { repository: repo, plan, reason } = analysis;
  const lines = [];

  lines.push('');
  lines.push(`  ${color.bold('git undo')}${repo?.branch ? color.grey(`  ·  ${repo.branch}`) : ''}`);
  lines.push('');

  if (!plan) {
    lines.push(`  ${reason ?? 'There is nothing to undo.'}`);
    lines.push('');
    return lines.join('\n');
  }

  const when = plan.at ? color.grey(relativeTime(plan.at)) : '';
  lines.push(`  ${plan.what}${when ? `  ${when}` : ''}`);
  lines.push('');
  lines.push(`  ${color.grey('undo with')}   ${color.bold(color.cyan(commandLine(plan)))}`);
  lines.push(`  ${color.grey('it will')}     ${plan.effect}`);
  lines.push(`  ${color.grey('risk')}        ${RISK[plan.risk]()}`);

  for (const warning of plan.warnings) {
    lines.push(`  ${color.grey('note')}        ${warning}`);
  }

  lines.push('');

  if (applied) {
    lines.push(...renderApplied(applied));
  } else {
    lines.push(`  ${color.grey('run it with')} ${color.bold('git undo --yes')}`);
    if (plan.risk === 'destructive') {
      lines.push(`  ${color.grey('            a backup ref is written first, so this stays reversible')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderApplied(applied) {
  const lines = [];

  if (applied.refused === 'dirty') {
    lines.push(`  ${color.red('refused')}     ${applied.message}`);
    lines.push(`  ${color.grey('       ')}     ${applied.suggestion}`);
    lines.push('');
    return lines;
  }

  if (!applied.ok) {
    lines.push(`  ${color.red('failed')}      ${applied.message}`);
    lines.push('');
    return lines;
  }

  lines.push(`  ${color.green('done')}        ${color.grey('the command above has been run')}`);
  if (applied.backup) {
    lines.push(`  ${color.grey('backup')}      ${applied.backup}`);
    lines.push(`  ${color.grey('go back')}     git reset --hard ${applied.backup}`);
  }
  lines.push('');
  return lines;
}

/** `git undo list` */
export function renderList(entries, describe) {
  const lines = ['', `  ${color.bold('recent history')}`, ''];

  for (const entry of entries) {
    const position = `HEAD@{${entry.index}}`.padEnd(10);
    const when = (entry.time ? relativeTime(entry.time) : '').padEnd(16);
    lines.push(`  ${color.grey(position)} ${color.grey(when)} ${describe(entry.subject)}`);
  }

  lines.push('');
  return lines.join('\n');
}

/** `git undo lost` */
export function renderLost(commits) {
  if (!commits.length) {
    return `\n  ${color.bold('lost commits')}\n\n  Nothing is dangling: every commit is still reachable.\n`;
  }

  const lines = ['', `  ${color.bold('lost commits')}`, color.grey('  commits no branch or tag points at any more'), ''];

  for (const commit of commits) {
    lines.push(`  ${color.yellow(commit.abbrev)}  ${commit.subject}  ${color.grey(relativeTime(commit.time))}`);
  }

  lines.push('');
  lines.push(`  ${color.grey('bring one back with')} git branch recovered ${commits[0].abbrev}`);
  lines.push('');
  return lines.join('\n');
}

/** `git undo backups` */
export function renderBackups(refs) {
  if (!refs.length) {
    return `\n  ${color.bold('backups')}\n\n  None yet. One is written every time you run git undo --yes.\n`;
  }

  const lines = ['', `  ${color.bold('backups')}`, color.grey('  where HEAD was, just before each undo'), ''];

  for (const backup of refs) {
    lines.push(`  ${color.yellow(backup.sha.slice(0, 7))}  ${color.grey(backup.at)}`);
    lines.push(`          git reset --hard ${backup.ref}`);
  }

  lines.push('');
  return lines.join('\n');
}

/** "3 minutes ago", from a unix timestamp. */
export function relativeTime(seconds, now = Date.now()) {
  const delta = Math.max(0, Math.round(now / 1000 - seconds));
  if (delta < 10) return 'just now';

  const scales = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
  ];

  let value = delta;
  for (const [size, unit] of scales) {
    if (value < size) {
      const rounded = Math.floor(value);
      return `${rounded} ${unit}${rounded === 1 ? '' : 's'} ago`;
    }
    value /= size;
  }

  const years = Math.floor(value);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}
