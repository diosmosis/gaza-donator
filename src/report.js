/**
 * Terminal output: the recipient table, the run summary and the ledger history.
 * Kept free of any card data by construction — it is only ever handed the
 * redacted form.
 */
import { platformLabel } from './url.js';
import { parseApiTime } from './time.js';
import { formatDuration } from './progress.js';

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code, text) => (COLOR ? `[${code}m${text}[0m` : text);
export const bold = (text) => paint('1', text);
export const dim = (text) => paint('2', text);
export const green = (text) => paint('32', text);
export const yellow = (text) => paint('33', text);
export const red = (text) => paint('31', text);
export const cyan = (text) => paint('36', text);

/**
 * A section title. Bold alone is already what the table headers use, so the
 * colour is what separates "this is a new block" from "this is a column name"
 * when a screen of output scrolls past.
 */
export const heading = (text) => paint('1;36', text);

/** Format money without pulling in a locale dependency for other currencies. */
export function formatMoney(amount, currency = 'USD') {
  const value = Number(amount ?? 0).toFixed(2);
  const withSeparators = value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return currency === 'USD' ? `$${withSeparators}` : `${withSeparators} ${currency}`;
}

/** "3 days ago" / "in 2 hours" — enough to judge whether a campaign is alive. */
export function formatAge(timestamp, now = Date.now()) {
  if (!timestamp) return 'never';
  const then = parseApiTime(timestamp);
  if (!Number.isFinite(then)) return 'unknown';

  const seconds = Math.round((now - then) / 1000);
  const units = [
    ['y', 365 * 24 * 3600],
    ['mo', 30 * 24 * 3600],
    ['d', 24 * 3600],
    ['h', 3600],
    ['m', 60],
  ];
  const absolute = Math.abs(seconds);
  for (const [label, size] of units) {
    if (absolute >= size) {
      const value = Math.floor(absolute / size);
      return seconds >= 0 ? `${value}${label} ago` : `in ${value}${label}`;
    }
  }
  return 'just now';
}

const ANSI = /\x1b\[\d+m/g;

/**
 * Printed width of a string: colour codes are invisible, and emoji (very common
 * in these display names) occupy two terminal cells, so `.length` misaligns
 * every column after them.
 */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text).replace(ANSI, '')) {
    const code = char.codePointAt(0);
    if (code < 0x20) continue; // control characters
    // Variation selectors and zero-width joiners take no space of their own.
    if (code === 0xfe0f || code === 0xfe0e || code === 0x200d) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0x1f300 && code <= 0x1f9ff) || // emoji
    (code >= 0x1fa70 && code <= 0x1faff) ||
    (code >= 0x2600 && code <= 0x27bf) // misc symbols and dingbats
  );
}

/** Truncate to a printed width, so a long emoji-laden name still fits a column. */
export function truncate(text, maxWidth) {
  if (displayWidth(text) <= maxWidth) return text;
  let out = '';
  for (const char of String(text)) {
    if (displayWidth(out + char) > maxWidth - 1) break;
    out += char;
  }
  return `${out}…`;
}

const visibleLength = displayWidth;

/**
 * Render a table. `columns` is [{key, header, align}].
 */
export function renderTable(rows, columns) {
  if (rows.length === 0) return dim('  (none)');

  const widths = columns.map((column) =>
    Math.max(
      visibleLength(column.header),
      ...rows.map((row) => visibleLength(row[column.key] ?? '')),
    ),
  );

  const pad = (text, width, align) => {
    const padding = ' '.repeat(Math.max(0, width - visibleLength(text)));
    return align === 'right' ? padding + text : text + padding;
  };

  const line = (cells) =>
    `  ${cells.map((cell, i) => pad(cell, widths[i], columns[i].align)).join('  ')}`.trimEnd();

  const out = [
    line(columns.map((column) => bold(column.header))),
    dim(`  ${widths.map((width) => '─'.repeat(width)).join('  ')}`),
  ];
  for (const row of rows) {
    out.push(line(columns.map((column) => String(row[column.key] ?? ''))));
  }
  return out.join('\n');
}

/**
 * The budget block above the plan table.
 *
 * The slot count is the number people misread, because it is what the
 * *remaining* budget buys rather than what the configured total buys. When part
 * of the period has already been donated away the two differ, so the
 * subtraction is spelled out here instead of being left to be re-derived from
 * the ledger by hand.
 */
export function renderBudget(
  budget,
  {
    currency,
    totalAmount,
    recurrence,
    donationAmount,
    tipAmount = 0,
    donations = 0,
    eligible = null,
    limit = null,
  },
) {
  const money = (amount) => formatMoney(amount, currency);
  const slotWord = (count) => `${count} slot${count === 1 ? '' : 's'}`;

  const lines = [
    `${heading('Budget')} ${bold(money(totalAmount))} ${dim(`per ${recurrence}`)}` +
      ` ${dim('·')} already donated this period ` +
      (budget.spent > 0 ? yellow(money(budget.spent)) : dim(money(0))) +
      ` ${dim('·')} remaining ${green(money(budget.remaining))}`,
    (eligible === null ? '' : `${bold(String(eligible))} eligible candidate(s) ${dim('·')} `) +
      `${bold(slotWord(budget.slots))} at ${green(money(donationAmount))}` +
      (tipAmount > 0
        ? ` + ${money(tipAmount)} platform tip ${dim(`(${money(budget.perRecipient)} each)`)}`
        : ' each') +
      (limit ? dim(`, limited to ${limit}`) : ''),
  ];

  // Only worth explaining when the two numbers actually disagree.
  if (budget.spent > 0) {
    lines.push(
      dim(
        `  ${money(totalAmount)} covers ${slotWord(budget.capacity)}; ` +
          `${donations} donation(s) already made this period spent ${money(budget.spent)}, ` +
          `leaving ${budget.slots}`,
      ),
    );
  }

  return lines.join('\n');
}

/** The plan table: who gets paid, and what they have received lately. */
export function renderRecipients(chosen, { currency, donationAmount, tipAmount = 0, periodLabel }) {
  const rows = chosen.map((candidate, index) => {
    const verification = candidate.verification;
    const raised = verification?.raisedTotal;
    // Converted totals are the ones ranked on; name the currency they came
    // from so a surprising order can be checked against the page itself.
    const raisedFrom =
      verification?.raisedCurrency && verification.raisedCurrency !== currency
        ? ` ${verification.raisedCurrency}`
        : '';
    return {
      n: String(index + 1),
      who: truncate(candidate.displayName || candidate.fqn, 28),
      fqn: dim(candidate.fqn),
      platform: cyan(platformLabel(candidate.platform)),
      received: formatMoney(candidate.receivedInPeriod, candidate.currency ?? currency),
      total: dim(formatMoney(candidate.receivedTotal ?? 0, candidate.currency ?? currency)),
      raised:
        raised === undefined || raised === null
          ? dim('—')
          : formatMoney(raised, currency) + dim(raisedFrom),
      active: formatAge(candidate.lastActivityTime),
      give: green(formatMoney(donationAmount, currency)),
      tip: dim(formatMoney(tipAmount, currency)),
    };
  });

  return renderTable(rows, [
    { key: 'n', header: '#', align: 'right' },
    { key: 'who', header: 'recipient' },
    { key: 'fqn', header: 'account' },
    { key: 'platform', header: 'platform' },
    { key: 'received', header: `received ${periodLabel}`, align: 'right' },
    // Both totals: the API's is what ranked the whole field, the page's is what
    // decided the final order among the people who were verified.
    { key: 'total', header: 'api total', align: 'right' },
    { key: 'raised', header: 'page total', align: 'right' },
    { key: 'active', header: 'last post', align: 'right' },
    { key: 'give', header: 'donate', align: 'right' },
    // Only worth a column when the platform is actually being tipped.
    ...(tipAmount > 0 ? [{ key: 'tip', header: 'platform tip', align: 'right' }] : []),
  ]);
}

/**
 * Grouped counts of why candidates were dropped.
 *
 * Reasons quote what a page said, so one of them can be a paragraph of markup;
 * a single such reason would otherwise set the width of the whole table.
 */
export function renderRejections(rejected, { maxReasonWidth = 90 } = {}) {
  const counts = new Map();
  for (const { reason } of rejected) counts.set(reason, (counts.get(reason) ?? 0) + 1);

  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({
      count: yellow(String(count)),
      reason: dim(truncate(String(reason).replace(/\s+/g, ' '), maxReasonWidth)),
    }));

  return renderTable(rows, [
    { key: 'count', header: 'count', align: 'right' },
    { key: 'reason', header: 'skipped because' },
  ]);
}

/** End-of-run summary, printed on success and on abort alike. */
export function renderSummary(results, { currency, totalAmount, spentBefore }) {
  const succeeded = results.filter((result) => result.status === 'success');
  const donated = succeeded.reduce((sum, result) => sum + result.amount, 0);
  const tipped = succeeded.reduce((sum, result) => sum + (result.tip ?? 0), 0);

  const rows = results.map((result) => ({
    who: result.fqn,
    amount: formatMoney(result.amount, currency),
    status:
      result.status === 'success'
        ? green('donated')
        : result.status === 'skipped'
          ? yellow('skipped')
          : red(result.status),
    note: dim(result.note ?? ''),
  }));

  const table = renderTable(rows, [
    { key: 'who', header: 'recipient' },
    { key: 'amount', header: 'amount', align: 'right' },
    { key: 'status', header: 'status' },
    { key: 'note', header: 'note' },
  ]);

  // Tips are charged to the same card, so they come out of the same budget.
  const remaining = Math.max(0, totalAmount - spentBefore - donated - tipped);
  return [
    '',
    heading('Summary'),
    table,
    '',
    `  donated this run: ${bold(green(formatMoney(donated, currency)))} to ${succeeded.length} recipient(s)`,
    ...(tipped > 0 ? [`  tipped to the platforms: ${formatMoney(tipped, currency)}`] : []),
    `  remaining in this period: ${green(formatMoney(remaining, currency))} ${dim(`of ${formatMoney(totalAmount, currency)}`)}`,
  ].join('\n');
}

/**
 * `check` output: what broke, grouped, then one block per campaign so the URLs
 * can be opened and looked at.
 */
export function renderCheckReport(results, { groups, elapsedMs, deep = false }) {
  const failed = results.filter((result) => !result.ok);
  const inconclusive = results.filter((result) => result.ok && result.inconclusive?.length > 0);
  const flaky = results.filter((result) => result.clearedOnRetry?.length > 0);
  const out = [];

  out.push('');
  out.push(heading('Summary'));
  out.push(
    `  checked ${results.length} campaign(s) in ${formatDuration(elapsedMs)}: ` +
      `${green(`${results.length - failed.length} ok`)}, ` +
      `${failed.length > 0 ? red(`${failed.length} with problems`) : '0 with problems'}` +
      (deep ? '' : dim(' (payment forms not checked — pass --deep)')),
  );

  if (groups.length > 0) {
    out.push('');
    out.push(
      renderTable(
        groups.map((group) => ({
          count: String(group.count),
          kind: group.kind === 'campaign' ? dim(group.kind) : yellow(group.kind),
          message: truncate(group.message, 80),
        })),
        [
          { key: 'count', header: 'count', align: 'right' },
          { key: 'kind', header: 'kind' },
          { key: 'message', header: 'problem' },
        ],
      ),
    );
    out.push('');
    out.push(
      dim(
        '  parse = the page loaded but this tool could not read it (likely a selector to fix)\n' +
          '  campaign = the campaign itself is gone, closed or unreachable\n' +
          '  blocked = a bot gate stood in the way, so nothing was learned either way',
      ),
    );
  }

  const blocked = results.filter((result) =>
    result.problems.some((problem) => problem.kind === 'blocked'),
  );
  if (blocked.length > 0) {
    out.push('');
    out.push(
      yellow(
        `  ${blocked.length} campaign(s) were behind a bot gate — not read, and not judged. ` +
          'They are in the gate log; see `gates`.',
      ),
    );
  }

  if (flaky.length > 0) {
    out.push('');
    out.push(
      dim(
        `  ${flaky.length} campaign(s) only parsed on the second attempt — the site was slow, ` +
          'not broken',
      ),
    );
  }

  if (inconclusive.length > 0) {
    out.push('');
    out.push(dim(`  ${inconclusive.length} payment form(s) could not be checked: bot protection`));
  }

  if (failed.length > 0) {
    out.push('');
    out.push(heading('Campaigns to look at'));
    for (const result of failed) {
      out.push('');
      out.push(`  ${result.fqn} ${dim(`(${platformLabel(result.platform) || 'unknown platform'})`)}`);
      out.push(`    ${dim(result.campaignUrl ?? 'no campaign url')}`);
      for (const problem of result.problems) {
        out.push(`    - ${problem.kind === 'parse' ? yellow(problem.message) : problem.message}`);
      }
    }
  }

  return out.join('\n');
}

/**
 * Bot gates: the ones this run walked into, and how many are on record.
 *
 * Printed after every command that opens pages, because a gate is the one
 * failure that looks exactly like a different failure — a closed campaign, or a
 * selector that stopped matching — and quietly changes who gets money.
 */
export function renderGates(seen, { total = seen.length, file = null } = {}) {
  if (seen.length === 0) {
    return total > 0 && file
      ? dim(`  no bot gates this run (${total} on record — see \`gates\`)`)
      : '';
  }

  const rows = seen.map((gate) => ({
    who: gate.fqn ?? dim('—'),
    kind: yellow(gate.kind),
    where: truncate(gate.url ?? '', 56),
    marker: dim(truncate(gate.marker ?? '', 28)),
  }));

  return [
    '',
    heading('Bot gates'),
    renderTable(rows, [
      { key: 'who', header: 'account' },
      { key: 'kind', header: 'gate' },
      { key: 'where', header: 'page' },
      { key: 'marker', header: 'seen as' },
    ]),
    dim(
      `  these pages were not read, so those candidates were passed over${
        file ? `. Logged to ${file} — see \`gates\`` : ''
      }`,
    ),
  ].join('\n');
}

/** `gates` output: the persistent log, grouped. */
export function renderGateLog(groups, { file }) {
  if (groups.length === 0) return dim(`  no bot gates recorded (${file})`);

  const rows = groups.map((group) => ({
    last: new Date(group.last).toISOString().replace('T', ' ').slice(0, 16),
    count: String(group.count),
    kind: yellow(group.kind),
    platform: group.platform ? platformLabel(group.platform) : dim('—'),
    stage: group.stage,
    example: dim(truncate(group.examples[0] ?? '', 52)),
  }));

  return renderTable(rows, [
    { key: 'last', header: 'last seen (UTC)' },
    { key: 'count', header: 'times', align: 'right' },
    { key: 'kind', header: 'gate' },
    { key: 'platform', header: 'platform' },
    { key: 'stage', header: 'during' },
    { key: 'example', header: 'example page' },
  ]);
}

/** `history` output. */
export function renderHistory(entries, { currency }) {
  const anyTips = entries.some((entry) => Number(entry.tip) > 0);
  const rows = entries
    .slice()
    .reverse()
    .map((entry) => ({
      at: new Date(entry.at).toISOString().replace('T', ' ').slice(0, 16),
      who: entry.fqn ?? '?',
      amount: formatMoney(entry.amount, entry.currency ?? currency),
      tip: dim(formatMoney(entry.tip ?? 0, entry.currency ?? currency)),
      status:
        entry.status === 'success'
          ? green(entry.status)
          : entry.status === 'failed'
            ? red(entry.status)
            : yellow(entry.status),
      note: dim([entry.dryRun ? 'dry-run' : '', entry.note ?? ''].filter(Boolean).join(' ')),
    }));

  return renderTable(rows, [
    { key: 'at', header: 'when (UTC)' },
    { key: 'who', header: 'recipient' },
    { key: 'amount', header: 'amount', align: 'right' },
    ...(anyTips ? [{ key: 'tip', header: 'tip', align: 'right' }] : []),
    { key: 'status', header: 'status' },
    { key: 'note', header: 'note' },
  ]);
}
