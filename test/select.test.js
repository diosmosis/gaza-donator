import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REASON,
  buildCandidates,
  filterCandidates,
  gazaVerifiedUrl,
  rankCandidates,
  selectRecipients,
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
  assert.equal(built.hasStats, false);
});

test('gazaVerifiedUrl finds the field regardless of case', () => {
  assert.equal(gazaVerifiedUrl({ profile_fields: { 'gaza verified': 'https://x' } }), 'https://x');
  assert.equal(gazaVerifiedUrl({ profile_fields: { Other: 'https://x' } }), null);
  assert.equal(gazaVerifiedUrl({}), null);
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

test('selectRecipients only verifies as far down the ranking as it needs to', async () => {
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
    verify: async (c) => {
      verified.push(c.fqn);
      return { ok: true, warnings: [] };
    },
  });

  assert.deepEqual(verified, ['@a@x'], 'should stop once the slot is filled');
});

test('selectRecipients returns nothing when there is no budget for anyone', async () => {
  const { chosen } = await selectRecipients({ candidates: [candidate()], ...DEFAULTS, slots: 0 });
  assert.deepEqual(chosen, []);
});
