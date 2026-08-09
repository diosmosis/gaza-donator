import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REASON,
  buildCandidates,
  filterCandidates,
  gazaVerifiedUrl,
  rankCandidates,
  rankVerified,
  selectRecipients,
  totalRaised,
} from '../src/select.js';
import { indexStatsByAccount } from '../src/api.js';

const accounts = JSON.parse(readFileSync(new URL('./fixtures/accounts.json', import.meta.url)));
const stats = JSON.parse(readFileSync(new URL('./fixtures/campaign-stats.json', import.meta.url)));

const DEFAULTS = {
  platforms: ['chuffed', 'gofundme'],
  includeStates: ['ACTIVE'],
  excludeAccounts: [],
};

function candidate(overrides = {}) {
  return {
    fqn: '@someone@mastodon.social',
    displayName: 'Someone',
    accountUrl: 'https://mastodon.social/@someone',
    campaignUrl: 'https://www.chuffed.org/project/someone',
    platform: 'chuffed',
    gazaVerifiedUrl: 'https://gaza-verified.org/people/@someone@mastodon.social/',
    state: 'ACTIVE',
    disabled: false,
    receivedInPeriod: 0,
    receivedTotal: 0,
    currency: 'USD',
    lastActivityTime: '2026-08-01T00:00:00',
    ...overrides,
  };
}

test('buildCandidates joins the roster with the donation totals', () => {
  const candidates = buildCandidates(accounts, indexStatsByAccount(stats));
  assert.equal(candidates.length, accounts.length);

  const gofundme = candidates.find((c) => c.platform === 'gofundme');
  assert.equal(gofundme.receivedInPeriod, 45.5);
  assert.ok(gofundme.gazaVerifiedUrl.startsWith('https://gaza-verified.org/people/'));

  const noCampaign = candidates.find((c) => c.campaignUrl === null);
  assert.equal(noCampaign.platform, null);
});

test('buildCandidates defaults an account with no stats row to zero received', () => {
  const [account] = accounts;
  const [built] = buildCandidates([account], new Map());
  assert.equal(built.receivedInPeriod, 0);
  assert.equal(built.receivedTotal, 0);
  assert.equal(built.hasStats, false);
});

test('buildCandidates takes the lifetime total from the unwindowed stats', () => {
  const [account] = accounts;
  const windowed = new Map([[account.url, { amount: 10, currency: 'USD' }]]);
  const lifetime = new Map([[account.url, { amount: 640, currency: 'USD' }]]);

  const [built] = buildCandidates([account], windowed, lifetime);
  assert.equal(built.receivedInPeriod, 10);
  assert.equal(built.receivedTotal, 640);
});

test('gazaVerifiedUrl finds the field regardless of case', () => {
  assert.equal(gazaVerifiedUrl({ profile_fields: { 'gaza verified': 'https://x' } }), 'https://x');
  assert.equal(gazaVerifiedUrl({ profile_fields: { Other: 'https://x' } }), null);
  assert.equal(gazaVerifiedUrl({}), null);
});

test('gazaVerifiedUrl unwraps a field served as rendered HTML', () => {
  // Ten live accounts are listed this way; reading the markup as a URL threw
  // them all out as unverified.
  const html =
    '<a href="https://gaza-verified.org/people/@mazuza@mastodon.social/" target="_blank" ' +
    'rel="nofollow noopener me"><span class="invisible">https://</span>' +
    '<span class="ellipsis">gaza-verified.org/people/@mazu</span></a>';

  assert.equal(
    gazaVerifiedUrl({ profile_fields: { 'Gaza Verified': html } }),
    'https://gaza-verified.org/people/@mazuza@mastodon.social/',
  );
  assert.equal(gazaVerifiedUrl({ profile_fields: { 'Gaza Verified': '<p>soon</p>' } }), null);
  assert.equal(gazaVerifiedUrl({ profile_fields: { 'Gaza Verified': '  ' } }), null);
});

test('filterCandidates drops every ineligible kind, with a reason', () => {
  const candidates = [
    candidate({ fqn: '@ok@x' }),
    candidate({ fqn: '@nocampaign@x', campaignUrl: null, platform: null }),
    candidate({ fqn: '@whydonate@x', platform: null }),
    candidate({ fqn: '@unverified@x', gazaVerifiedUrl: null }),
    candidate({ fqn: '@limited@x', state: 'LIMITED' }),
    candidate({ fqn: '@disabled@x', disabled: true }),
    candidate({ fqn: '@excluded@x' }),
  ];

  const { eligible, rejected } = filterCandidates(candidates, {
    ...DEFAULTS,
    excludeAccounts: ['@excluded@x'],
  });

  assert.deepEqual(
    eligible.map((c) => c.fqn),
    ['@ok@x'],
  );
  const reasons = Object.fromEntries(rejected.map((r) => [r.candidate.fqn, r.reason]));
  assert.equal(reasons['@nocampaign@x'], REASON.NO_CAMPAIGN);
  assert.equal(reasons['@whydonate@x'], REASON.UNSUPPORTED_PLATFORM);
  assert.equal(reasons['@unverified@x'], REASON.NOT_GAZA_VERIFIED);
  assert.equal(reasons['@limited@x'], REASON.STATE);
  assert.equal(reasons['@disabled@x'], REASON.DISABLED);
  assert.equal(reasons['@excluded@x'], REASON.EXCLUDED);
});

test('filterCandidates admits LIMITED accounts only when configured to', () => {
  const candidates = [candidate({ fqn: '@limited@x', state: 'LIMITED' })];
  assert.equal(filterCandidates(candidates, DEFAULTS).eligible.length, 0);
  assert.equal(
    filterCandidates(candidates, { ...DEFAULTS, includeStates: ['ACTIVE', 'LIMITED'] }).eligible
      .length,
    1,
  );
});

test('filterCandidates excludes by campaign URL as well as by account', () => {
  const candidates = [candidate({ campaignUrl: 'https://www.chuffed.org/project/x' })];
  const { eligible } = filterCandidates(candidates, {
    ...DEFAULTS,
    excludeAccounts: ['https://www.chuffed.org/project/X'],
  });
  assert.equal(eligible.length, 0);
});

test('filterCandidates skips anyone already paid this period', () => {
  const candidates = [candidate({ fqn: '@paid@x' }), candidate({ fqn: '@unpaid@x' })];
  const { eligible, rejected } = filterCandidates(candidates, {
    ...DEFAULTS,
    alreadyDonated: new Set(['@paid@x']),
  });
  assert.deepEqual(
    eligible.map((c) => c.fqn),
    ['@unpaid@x'],
  );
  assert.equal(rejected[0].reason, REASON.ALREADY_DONATED);
});

test('rankCandidates puts the least funded first', () => {
  const ranked = rankCandidates([
    candidate({ fqn: '@rich@x', receivedInPeriod: 500 }),
    candidate({ fqn: '@poor@x', receivedInPeriod: 0 }),
    candidate({ fqn: '@middle@x', receivedInPeriod: 40 }),
  ]);
  assert.deepEqual(
    ranked.map((c) => c.fqn),
    ['@poor@x', '@middle@x', '@rich@x'],
  );
});

test('among people who received nothing this period, the least funded overall comes first', () => {
  const ranked = rankCandidates([
    candidate({ fqn: '@wellfunded@x', accountUrl: 'https://a', receivedInPeriod: 0, receivedTotal: 200 }),
    candidate({ fqn: '@new@x', accountUrl: 'https://b', receivedInPeriod: 0, receivedTotal: 0 }),
    candidate({ fqn: '@some@x', accountUrl: 'https://c', receivedInPeriod: 0, receivedTotal: 50 }),
  ]);
  assert.deepEqual(
    ranked.map((c) => c.fqn),
    ['@new@x', '@some@x', '@wellfunded@x'],
  );
});

test('the period total still outranks the lifetime total', () => {
  // Someone paid this week is not a better candidate for being poorer overall.
  const ranked = rankCandidates([
    candidate({ fqn: '@paidthisweek@x', accountUrl: 'https://a', receivedInPeriod: 5, receivedTotal: 0 }),
    candidate({ fqn: '@missed@x', accountUrl: 'https://b', receivedInPeriod: 0, receivedTotal: 900 }),
  ]);
  assert.deepEqual(
    ranked.map((c) => c.fqn),
    ['@missed@x', '@paidthisweek@x'],
  );
});

test('rankVerified prefers the campaign page total over the API total', () => {
  const withPage = (fqn, receivedTotal, raisedTotal) => ({
    ...candidate({ fqn, accountUrl: `https://${fqn}`, receivedTotal }),
    verification: { ok: true, raisedTotal },
  });

  const ranked = rankVerified([
    withPage('@a@x', 0, 900),
    withPage('@b@x', 900, 10),
    withPage('@c@x', 500, 0),
  ]);
  assert.deepEqual(
    ranked.map((c) => c.fqn),
    ['@c@x', '@b@x', '@a@x'],
  );
});

test('totalRaised falls back to the API total when nothing was scraped', () => {
  assert.equal(totalRaised({ receivedTotal: 42 }), 42);
  assert.equal(totalRaised({ receivedTotal: 42, verification: { raisedTotal: null } }), 42);
  assert.equal(totalRaised({ receivedTotal: 42, verification: { raisedTotal: 7 } }), 7);
  assert.equal(totalRaised({ receivedTotal: 42, verification: { raisedTotal: 0 } }), 0);
  assert.equal(totalRaised({}), 0);
});

test('rankCandidates breaks ties on recent activity, then deterministically', () => {
  const ranked = rankCandidates([
    candidate({ fqn: '@stale@x', accountUrl: 'https://b', lastActivityTime: '2025-01-01T00:00:00' }),
    candidate({ fqn: '@fresh@x', accountUrl: 'https://c', lastActivityTime: '2026-08-07T00:00:00' }),
    candidate({ fqn: '@nodate@x', accountUrl: 'https://a', lastActivityTime: null }),
  ]);
  assert.deepEqual(
    ranked.map((c) => c.fqn),
    ['@fresh@x', '@stale@x', '@nodate@x'],
  );
});

test('rankCandidates reads naive API timestamps as UTC, not local time', () => {
  // Same instant, one spelled with a zone and one without: the tie-break must
  // not depend on the machine's offset.
  const ranked = rankCandidates([
    candidate({ fqn: '@naive@x', accountUrl: 'https://a', lastActivityTime: '2026-08-07T12:00:00' }),
    candidate({ fqn: '@zoned@x', accountUrl: 'https://b', lastActivityTime: '2026-08-07T12:00:00Z' }),
  ]);
  // Equal times fall through to the accountUrl tie-break.
  assert.deepEqual(
    ranked.map((c) => c.fqn),
    ['@naive@x', '@zoned@x'],
  );
});

test('rankCandidates does not mutate its input', () => {
  const input = [candidate({ fqn: '@b@x', receivedInPeriod: 10 }), candidate({ fqn: '@a@x' })];
  rankCandidates(input);
  assert.equal(input[0].fqn, '@b@x');
});

test('selectRecipients fills exactly the available slots, cheapest first', async () => {
  const candidates = [
    candidate({ fqn: '@a@x', accountUrl: 'https://a', receivedInPeriod: 0 }),
    candidate({ fqn: '@b@x', accountUrl: 'https://b', receivedInPeriod: 5 }),
    candidate({ fqn: '@c@x', accountUrl: 'https://c', receivedInPeriod: 50 }),
  ];
  const { chosen } = await selectRecipients({ candidates, ...DEFAULTS, slots: 2 });
  assert.deepEqual(
    chosen.map((c) => c.fqn),
    ['@a@x', '@b@x'],
  );
});

test('selectRecipients pulls the next candidate up when verification fails', async () => {
  const candidates = [
    candidate({ fqn: '@bad@x', accountUrl: 'https://a', receivedInPeriod: 0 }),
    candidate({ fqn: '@good@x', accountUrl: 'https://b', receivedInPeriod: 5 }),
  ];
  const verify = async (c) =>
    c.fqn === '@bad@x' ? { ok: false, note: 'campaign closed' } : { ok: true, warnings: [] };

  const { chosen, rejected } = await selectRecipients({
    candidates,
    ...DEFAULTS,
    slots: 1,
    verify,
  });

  assert.deepEqual(
    chosen.map((c) => c.fqn),
    ['@good@x'],
  );
  assert.ok(rejected.some((r) => r.reason === 'campaign closed'));
});

test('a pool factor of 1 verifies only as far down the ranking as it needs to', async () => {
  const verified = [];
  const candidates = [
    candidate({ fqn: '@a@x', accountUrl: 'https://a', receivedInPeriod: 0 }),
    candidate({ fqn: '@b@x', accountUrl: 'https://b', receivedInPeriod: 1 }),
    candidate({ fqn: '@c@x', accountUrl: 'https://c', receivedInPeriod: 2 }),
  ];

  await selectRecipients({
    candidates,
    ...DEFAULTS,
    slots: 1,
    poolFactor: 1,
    verify: async (c) => {
      verified.push(c.fqn);
      return { ok: true, warnings: [] };
    },
  });

  assert.deepEqual(verified, ['@a@x'], 'should stop once the slot is filled');
});

test('a larger pool factor verifies a shortlist and pays the least funded of it', async () => {
  const verified = [];
  // All tied at $0 this period, so the API totals order them; the scraped page
  // totals then disagree with that order, and the page totals win.
  const candidates = [
    candidate({ fqn: '@a@x', accountUrl: 'https://a', receivedTotal: 10 }),
    candidate({ fqn: '@b@x', accountUrl: 'https://b', receivedTotal: 20 }),
    candidate({ fqn: '@c@x', accountUrl: 'https://c', receivedTotal: 30 }),
    candidate({ fqn: '@d@x', accountUrl: 'https://d', receivedTotal: 9000 }),
  ];
  const pageTotals = { '@a@x': 5000, '@b@x': 40, '@c@x': 12 };

  const { chosen, pool } = await selectRecipients({
    candidates,
    ...DEFAULTS,
    slots: 1,
    poolFactor: 3,
    verify: async (c) => {
      verified.push(c.fqn);
      return { ok: true, raisedTotal: pageTotals[c.fqn], warnings: [] };
    },
  });

  assert.deepEqual(verified, ['@a@x', '@b@x', '@c@x'], 'three verified for one slot');
  assert.deepEqual(
    chosen.map((c) => c.fqn),
    ['@c@x'],
    'the smallest page total wins, not the smallest API total',
  );
  assert.deepEqual(
    pool.map((c) => c.fqn),
    ['@c@x', '@b@x', '@a@x'],
  );
});

test('a candidate whose page total could not be read keeps its API total', async () => {
  // Reading a null as $0 would push whoever we know least about to the front.
  const candidates = [
    candidate({ fqn: '@known@x', accountUrl: 'https://a', receivedTotal: 10 }),
    candidate({ fqn: '@unread@x', accountUrl: 'https://b', receivedTotal: 5000 }),
  ];

  const { chosen } = await selectRecipients({
    candidates,
    ...DEFAULTS,
    slots: 1,
    poolFactor: 2,
    verify: async (c) => ({
      ok: true,
      raisedTotal: c.fqn === '@known@x' ? 10 : null,
      warnings: [],
    }),
  });

  assert.deepEqual(
    chosen.map((c) => c.fqn),
    ['@known@x'],
  );
});

test('the shortlist is filled with candidates that pass, not attempts', async () => {
  const verified = [];
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((id) =>
    candidate({ fqn: `@${id}@x`, accountUrl: `https://${id}` }),
  );

  const { chosen } = await selectRecipients({
    candidates,
    ...DEFAULTS,
    slots: 1,
    poolFactor: 2,
    verify: async (c) => {
      verified.push(c.fqn);
      return c.fqn === '@a@x' || c.fqn === '@b@x'
        ? { ok: false, note: 'campaign closed' }
        : { ok: true, raisedTotal: 1, warnings: [] };
    },
  });

  assert.deepEqual(verified, ['@a@x', '@b@x', '@c@x', '@d@x'], 'two failures do not fill the pool');
  assert.equal(chosen.length, 1);
});

test('selectRecipients returns nothing when there is no budget for anyone', async () => {
  const { chosen } = await selectRecipients({ candidates: [candidate()], ...DEFAULTS, slots: 0 });
  assert.deepEqual(chosen, []);
});

test('selectRecipients announces each verification so a caller can show progress', async () => {
  // Verification opens a campaign page per candidate; without these events a
  // plan looks frozen for minutes.
  const events = [];
  const candidates = ['a', 'b', 'c', 'd'].map((id) =>
    candidate({ fqn: `@${id}@x`, accountUrl: `https://${id}` }),
  );

  await selectRecipients({
    candidates,
    ...DEFAULTS,
    slots: 1,
    poolFactor: 2,
    verify: async (c) => (c.fqn === '@a@x' ? { ok: false, note: 'closed' } : { ok: true }),
    onVerifyStart: (c, { filled, target }) => events.push(`start ${c.fqn} ${filled}/${target}`),
    onVerifyResult: (c, { ok }) => events.push(`${ok ? 'ok' : 'dropped'} ${c.fqn}`),
  });

  assert.deepEqual(events, [
    'start @a@x 0/2',
    'dropped @a@x',
    'start @b@x 0/2',
    'ok @b@x',
    'start @c@x 1/2',
    'ok @c@x',
  ]);
});

test('the shortlist size is known from the first event, before any page is opened', async () => {
  // The caller sizes its progress bar from this, so it has to be right on the
  // very first callback rather than settling later.
  const targets = [];
  const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
    candidate({ fqn: `@${id}@x`, accountUrl: `https://${id}` }),
  );

  await selectRecipients({
    candidates,
    ...DEFAULTS,
    slots: 2,
    poolFactor: 3,
    verify: async () => ({ ok: true }),
    onVerifyStart: (c, { target }) => targets.push(target),
  });

  assert.deepEqual(targets, [6, 6, 6, 6, 6, 6], '2 slots x 3 = a shortlist of 6');
});
