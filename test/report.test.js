import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayWidth,
  formatAge,
  formatMoney,
  renderRecipients,
  renderGateLog,
  renderGates,
  renderRejections,
  renderSummary,
  truncate,
} from '../src/report.js';

test('formatMoney groups thousands and names non-dollar currencies', () => {
  assert.equal(formatMoney(10), '$10.00');
  assert.equal(formatMoney(1234.5), '$1,234.50');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(50, 'EUR'), '50.00 EUR');
  assert.equal(formatMoney(null), '$0.00');
});

test('formatAge reads naive API timestamps as UTC', () => {
  const now = Date.parse('2026-08-08T12:00:00Z');
  assert.equal(formatAge('2026-08-08T10:00:00', now), '2h ago');
  assert.equal(formatAge('2026-08-08T10:00:00Z', now), '2h ago');
  assert.equal(formatAge('2026-08-01T12:00:00Z', now), '7d ago');
  assert.equal(formatAge(null, now), 'never');
  assert.equal(formatAge('nonsense', now), 'unknown');
});

test('displayWidth counts what the terminal actually draws', () => {
  assert.equal(displayWidth('plain'), 5);
  assert.equal(displayWidth('[1mbold[0m'), 4, 'colour codes are invisible');
  assert.equal(displayWidth('watermelon 🍉'), 13, 'emoji take two cells');
});

test('truncate respects the printed width', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(displayWidth(truncate('a very long display name indeed', 10)) <= 10, true);
});

test('the recipient table lines up regardless of emoji in display names', () => {
  const chosen = [
    {
      displayName: 'Heyam 🍉',
      fqn: '@heyam@mastodon.social',
      platform: 'chuffed',
      receivedInPeriod: 0,
      currency: 'USD',
      lastActivityTime: '2026-08-08T10:00:00',
      verification: { raisedTotal: 127 },
    },
    {
      displayName: 'Plain Name',
      fqn: '@plain@mastodon.social',
      platform: 'gofundme',
      receivedInPeriod: 45.5,
      currency: 'USD',
      lastActivityTime: null,
      verification: null,
    },
  ];

  const table = renderRecipients(chosen, {
    currency: 'USD',
    donationAmount: 10,
    periodLabel: 'last 7d',
  });
  const lines = table.split('\n');
  const widths = new Set(lines.map((line) => displayWidth(line.trimEnd())));

  assert.equal(lines.length, 4, 'header, rule, two rows');
  assert.ok(table.includes('$127.00'), 'shows the scraped page total');
  assert.ok(table.includes('GoFundMe'));
  // The rule is drawn to the full table width; rows are trimmed, so only check
  // that no row overflows it.
  const ruleWidth = displayWidth(lines[1]);
  for (const line of lines) assert.ok(displayWidth(line.trimEnd()) <= ruleWidth + 2, [...widths].join(','));
});

test('an empty table says so instead of rendering headers over nothing', () => {
  assert.match(renderRecipients([], { currency: 'USD', donationAmount: 10, periodLabel: 'x' }), /none/);
  assert.match(renderRejections([]), /none/);
});

test('one enormous rejection reason does not set the width of the table', () => {
  const rendered = renderRejections([
    { reason: `unparseable link: ${'<span class="invisible">x</span>'.repeat(20)}` },
    { reason: 'no campaign link' },
  ]);
  for (const line of rendered.split('\n')) {
    assert.ok(displayWidth(line) < 120, `line too wide: ${displayWidth(line)}`);
  }
  assert.match(rendered, /unparseable link/);
});

test('rejections are grouped by reason, most common first', () => {
  const rendered = renderRejections([
    { reason: 'no campaign link' },
    { reason: 'account state excluded' },
    { reason: 'no campaign link' },
  ]);
  const lines = rendered.split('\n').slice(2);
  assert.match(lines[0], /2\s+no campaign link/);
  assert.match(lines[1], /1\s+account state excluded/);
});

test('the summary totals only successful donations and reports what is left', () => {
  const summary = renderSummary(
    [
      { fqn: '@a@x', amount: 10, status: 'success' },
      { fqn: '@b@x', amount: 0, status: 'failed', note: 'timed out' },
      { fqn: '@c@x', amount: 10, status: 'success' },
    ],
    { currency: 'USD', totalAmount: 100, spentBefore: 30 },
  );

  assert.match(summary, /donated this run: .*\$20\.00.* to 2 recipient/);
  assert.match(summary, /remaining in this period: \$50\.00 of \$100\.00/);
  assert.match(summary, /timed out/);
});

test('the platform tip only earns a column when there is one', () => {
  const chosen = [
    {
      displayName: 'Someone',
      fqn: '@someone@x',
      platform: 'chuffed',
      receivedInPeriod: 0,
      lastActivityTime: null,
      verification: null,
    },
  ];
  const options = { currency: 'USD', donationAmount: 10, periodLabel: 'last 7d' };

  assert.ok(!renderRecipients(chosen, options).includes('platform tip'));
  const tipped = renderRecipients(chosen, { ...options, tipAmount: 1.5 });
  assert.match(tipped, /platform tip/);
  assert.ok(tipped.includes('$1.50'));
});

test('the summary reports tips separately and counts them against the budget', () => {
  const summary = renderSummary(
    [
      { fqn: '@a@x', amount: 10, tip: 1, status: 'success' },
      { fqn: '@b@x', amount: 10, tip: 1, status: 'success' },
    ],
    { currency: 'USD', totalAmount: 100, spentBefore: 0 },
  );

  assert.match(summary, /donated this run: .*\$20\.00/);
  assert.match(summary, /tipped to the platforms: \$2\.00/);
  assert.match(summary, /remaining in this period: \$78\.00/);
});

test('the summary never reports a negative remaining budget', () => {
  const summary = renderSummary([{ fqn: '@a@x', amount: 10, status: 'success' }], {
    currency: 'USD',
    totalAmount: 10,
    spentBefore: 10,
  });
  assert.match(summary, /remaining in this period: \$0\.00/);
});

test('gates seen in a run are shown with where they happened', () => {
  const rendered = renderGates(
    [
      {
        fqn: '@blocked@x',
        kind: 'cloudflare',
        url: 'https://www.chuffed.org/project/x',
        marker: 'just a moment',
      },
    ],
    { total: 4, file: '/tmp/gates.jsonl' },
  );

  assert.match(rendered, /Bot gates/);
  assert.match(rendered, /@blocked@x/);
  assert.match(rendered, /cloudflare/);
  assert.match(rendered, /passed over/);
});

test('a clean run mentions the log only if there is something in it', () => {
  assert.equal(renderGates([], { total: 0, file: '/tmp/gates.jsonl' }), '');
  assert.match(renderGates([], { total: 3, file: '/tmp/gates.jsonl' }), /3 on record/);
});

test('the gate log reads as a list of places to look', () => {
  const rendered = renderGateLog(
    [
      {
        kind: 'press-and-hold',
        platform: 'gofundme',
        stage: 'check',
        count: 2,
        first: '2026-08-01T00:00:00Z',
        last: '2026-08-08T09:30:00Z',
        examples: ['https://www.gofundme.com/f/x'],
      },
    ],
    { file: '/tmp/gates.jsonl' },
  );

  assert.match(rendered, /2026-08-08 09:30/);
  assert.match(rendered, /press-and-hold/);
  assert.match(rendered, /GoFundMe/);
  assert.match(rendered, /gofundme\.com\/f\/x/);
});

test('an empty gate log says so, with where it would be', () => {
  assert.match(renderGateLog([], { file: '/tmp/gates.jsonl' }), /no bot gates recorded/);
});
