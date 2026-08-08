/**
 * Terminal output: the recipient table, the run summary and the ledger history.
 * Kept free of any card data by construction — it is only ever handed the
 * redacted form.
 */
import { platformLabel } from './url.js';
import { parseApiTime } from './time.js';

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code, text) => (COLOR ? `[${code}m${text}[0m` : text);
export const bold = (text) => paint('1', text);
export const dim = (text) => paint('2', text);
export const green = (text) => paint('32', text);
export const yellow = (text) => paint('33', text);
export const red = (text) => paint('31', text);

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
    `  ${widths.map((width) => '─'.repeat(width)).join('  ')}`,
  ];
  for (const row of rows) {
    out.push(line(columns.map((column) => String(row[column.key] ?? ''))));
  }
  return out.join('\n');
}

/** The plan table: who gets paid, and what they have received lately. */
export function renderRecipients(chosen, { currency, donationAmount, tipAmount = 0, periodLabel }) {
  const rows = chosen.map((candidate, index) => {
    const verification = candidate.verification;
    const raised = verification?.raisedTotal;
    return {
      n: String(index + 1),
      who: truncate(candidate.displayName || candidate.fqn, 28),
      fqn: dim(candidate.fqn),
      platform: platformLabel(candidate.platform),
      received: formatMoney(candidate.receivedInPeriod, candidate.currency ?? currency),
      raised: raised === undefined || raised === null ? dim('—') : formatMoney(raised, currency),
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
    { key: 'raised', header: 'page total', align: 'right' },
    { key: 'active', header: 'last post', align: 'right' },
    { key: 'give', header: 'donate', align: 'right' },
    // Only worth a column when the platform is actually being tipped.
    ...(tipAmount > 0 ? [{ key: 'tip', header: 'platform tip', align: 'right' }] : []),
  ]);
}

/** Grouped counts of why candidates were dropped. */
export function renderRejections(rejected) {
  const counts = new Map();
  for (const { reason } of rejected) counts.set(reason, (counts.get(reason) ?? 0) + 1);

  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ count: String(count), reason }));

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
    bold('Summary'),
    table,
    '',
    `  donated this run: ${bold(formatMoney(donated, currency))} to ${succeeded.length} recipient(s)`,
    ...(tipped > 0 ? [`  tipped to the platforms: ${formatMoney(tipped, currency)}`] : []),
    `  remaining in this period: ${formatMoney(remaining, currency)} of ${formatMoney(totalAmount, currency)}`,
  ].join('\n');
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
      status: entry.status === 'success' ? green(entry.status) : yellow(entry.status),
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
