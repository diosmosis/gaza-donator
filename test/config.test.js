import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  chargePerRecipient,
  impliedRecipients,
  loadConfig,
  recurrenceDays,
  validateConfig,
  windowStart,
} from '../src/config.js';
import { resolvePaths } from '../src/paths.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pd-home-'));

test('recurrenceDays understands presets, shorthand and plain numbers', () => {
  assert.equal(recurrenceDays('weekly'), 7);
  assert.equal(recurrenceDays('Monthly'), 30);
  assert.equal(recurrenceDays('10d'), 10);
  assert.equal(recurrenceDays('2w'), 14);
  assert.equal(recurrenceDays('3 months'), 90);
  assert.equal(recurrenceDays(5), 5);
});

test('recurrenceDays rejects nonsense rather than defaulting silently', () => {
  for (const value of ['', 'sometimes', '0d', '-3', null, {}]) {
    assert.throws(() => recurrenceDays(value), /invalid recurrence/, `for ${JSON.stringify(value)}`);
  }
});

test('windowStart goes back exactly one recurrence period', () => {
  const now = new Date('2026-08-08T12:00:00Z');
  const start = windowStart({ recurrence: 'weekly' }, now);
  assert.equal(now.getTime() - start.getTime() >= 7 * 86400_000, true);
  assert.equal(now.getTime() - start.getTime() < 7 * 86400_000 + 15 * 60_000, true);
});

test('windowStart is quantised so repeated runs share a cache entry', () => {
  const config = { recurrence: 'weekly' };
  const a = windowStart(config, new Date('2026-08-08T12:00:03Z'));
  const b = windowStart(config, new Date('2026-08-08T12:07:59Z'));
  assert.equal(a.getTime(), b.getTime());

  const later = windowStart(config, new Date('2026-08-08T12:16:00Z'));
  assert.notEqual(a.getTime(), later.getTime());
});

test('validateConfig accepts the defaults', () => {
  assert.doesNotThrow(() => validateConfig({ ...DEFAULT_CONFIG }));
});

test('validateConfig rejects configurations that would misspend money', () => {
  const cases = [
    [{ totalAmount: 0 }, /totalAmount/],
    [{ donationAmount: -5 }, /donationAmount/],
    [{ donationAmount: 500 }, /cannot exceed totalAmount/],
    [{ tipAmount: -1 }, /tipAmount/],
    [{ tipAmount: 'lots' }, /tipAmount/],
    [{ totalAmount: 10, donationAmount: 10, tipAmount: 1 }, /cannot exceed totalAmount/],
    [{ currency: 'dollars' }, /currency/],
    [{ recurrence: 'whenever' }, /recurrence/],
    [{ platforms: [] }, /platforms/],
    [{ platforms: ['patreon'] }, /unsupported platform/],
    [{ maxRecipients: 0 }, /maxRecipients/],
    [{ retries: -1 }, /retries/],
    [{ maxConsecutiveFailures: 0 }, /maxConsecutiveFailures/],
    [{ excludeAccounts: 'nobody' }, /excludeAccounts/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(
      () => validateConfig({ ...DEFAULT_CONFIG, ...override }),
      pattern,
      `expected ${JSON.stringify(override)} to be rejected`,
    );
  }
});

test('a tip is part of what each recipient costs', () => {
  assert.equal(chargePerRecipient({ donationAmount: 10, tipAmount: 0 }), 10);
  assert.equal(chargePerRecipient({ donationAmount: 10, tipAmount: 1.5 }), 11.5);
  assert.equal(chargePerRecipient({ donationAmount: 10 }), 10, 'an absent tip is no tip');

  assert.equal(impliedRecipients({ totalAmount: 200, donationAmount: 10, tipAmount: 0 }), 20);
  assert.equal(impliedRecipients({ totalAmount: 200, donationAmount: 10, tipAmount: 2.5 }), 16);
});

test('a budget that would pay more people than maxRecipients is a hard stop', () => {
  // $200 at $5 each is 40 people, but only 25 would ever be paid: the rest of
  // the budget would vanish into the cap. That is a typo, not a plan.
  assert.throws(
    () => validateConfig({ ...DEFAULT_CONFIG, totalAmount: 200, donationAmount: 5 }),
    /misconfigured budget[\s\S]*40 people[\s\S]*maxRecipients is 25/,
  );

  // Both stated ways out of it work.
  assert.doesNotThrow(() =>
    validateConfig({ ...DEFAULT_CONFIG, totalAmount: 200, donationAmount: 5, maxRecipients: 40 }),
  );
  assert.doesNotThrow(() =>
    validateConfig({ ...DEFAULT_CONFIG, totalAmount: 125, donationAmount: 5 }),
  );
});

test('the recipient-count check counts the tip as part of each donation', () => {
  // 20 x $10 fits under a cap of 20; adding a tip means fewer people, not more.
  assert.doesNotThrow(() =>
    validateConfig({ ...DEFAULT_CONFIG, totalAmount: 200, donationAmount: 10, maxRecipients: 20 }),
  );
  assert.doesNotThrow(() =>
    validateConfig({
      ...DEFAULT_CONFIG,
      totalAmount: 200,
      donationAmount: 10,
      tipAmount: 1,
      maxRecipients: 18,
    }),
  );
  assert.throws(
    () =>
      validateConfig({
        ...DEFAULT_CONFIG,
        totalAmount: 200,
        donationAmount: 10,
        tipAmount: 1,
        maxRecipients: 17,
      }),
    /18 people/,
  );
});

test('the recipient-count check cannot be bypassed by any command or flag', () => {
  const home = tempHome();
  const paths = resolvePaths({ PALESTINE_DONATOR_HOME: home });
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.configFile, JSON.stringify({ totalAmount: 200, donationAmount: 5 }));

  // Every command loads its configuration through here, so there is nowhere the
  // check does not run.
  assert.throws(
    () => loadConfig({ env: { PALESTINE_DONATOR_HOME: home } }),
    /misconfigured budget/,
  );
  // A CLI override is checked on the same terms, not exempted from them.
  assert.throws(
    () => loadConfig({ env: { PALESTINE_DONATOR_HOME: home }, overrides: { donationAmount: 2 } }),
    /misconfigured budget/,
  );
  assert.doesNotThrow(() =>
    loadConfig({ env: { PALESTINE_DONATOR_HOME: home }, overrides: { maxRecipients: 40 } }),
  );
});

test('loadConfig returns the defaults when no config file exists', () => {
  const home = tempHome();
  const { config, fileExists } = loadConfig({ env: { PALESTINE_DONATOR_HOME: home } });
  assert.equal(fileExists, false);
  assert.equal(config.totalAmount, DEFAULT_CONFIG.totalAmount);
});

test('loadConfig layers file over defaults and overrides over both', () => {
  const home = tempHome();
  const paths = resolvePaths({ PALESTINE_DONATOR_HOME: home });
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(
    paths.configFile,
    JSON.stringify({ totalAmount: 100, donationAmount: 5, verify: { raisedTotal: false } }),
  );

  const { config } = loadConfig({
    env: { PALESTINE_DONATOR_HOME: home },
    overrides: { donationAmount: 20 },
  });

  assert.equal(config.totalAmount, 100, 'from the file');
  assert.equal(config.donationAmount, 20, 'override wins');
  assert.equal(config.currency, 'USD', 'default survives');
  assert.equal(config.verify.raisedTotal, false, 'nested object merges');
  assert.equal(config.verify.campaign, true, 'rather than replacing the whole object');
});

test('loadConfig refuses a config file that was asked for but is missing', () => {
  assert.throws(() => loadConfig({ file: '/nonexistent/config.json' }), /not found/);
});

test('loadConfig explains a malformed config file', () => {
  const home = tempHome();
  const paths = resolvePaths({ PALESTINE_DONATOR_HOME: home });
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.configFile, '{ nope');

  assert.throws(() => loadConfig({ env: { PALESTINE_DONATOR_HOME: home } }), /not valid JSON/);
});

test('state lives outside the repo, in per-purpose directories', () => {
  const paths = resolvePaths({ PALESTINE_DONATOR_HOME: '/tmp/pd' });
  assert.equal(paths.configFile, '/tmp/pd/config/config.json');
  assert.equal(paths.cardFile, '/tmp/pd/config/card.enc');
  assert.equal(paths.ledgerFile, '/tmp/pd/data/ledger.jsonl');
  assert.equal(paths.cacheDir, '/tmp/pd/cache');
});
