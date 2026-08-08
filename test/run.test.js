/**
 * The payment loop, driven with a fake browser and fake drivers.
 *
 * This is the code that decides whether money keeps moving after something goes
 * wrong, so the retry, abort and bookkeeping rules are tested directly rather
 * than left to a live run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeDonations } from '../src/run.js';
import { Ledger, STATUS } from '../src/ledger.js';

const CONFIG = {
  donationAmount: 10,
  currency: 'USD',
  retries: 2,
  maxConsecutiveFailures: 3,
  donationTimeoutMs: 1000,
  debug: false,
  donor: { name: 'A Donor', email: 'a@example.com', anonymous: true },
};

const CARD = { number: '4111111111111111', expMonth: 12, expYear: 2030, cvc: '123', name: 'A Donor' };

function recipient(n) {
  return {
    fqn: `@person${n}@x`,
    displayName: `Person ${n}`,
    campaignUrl: `https://www.chuffed.org/project/${n}`,
    platform: 'chuffed',
    receivedInPeriod: 0,
  };
}

/** A browser whose pages do nothing; the fake drivers never touch them. */
const fakeBrowser = () => ({
  closed: false,
  async newPage() {
    return { isClosed: () => false, close: async () => {}, url: () => 'about:blank' };
  },
  async close() {
    this.closed = true;
  },
});

/**
 * A driver scripted per attempt: `outcomes` is consumed one entry per prepare.
 * 'ok' confirms, 'no' fails to confirm, 'throw' blows up mid-prepare.
 */
function fakeDriver(outcomes) {
  const calls = [];
  return {
    calls,
    driver: {
      id: 'fake',
      async prepare() {
        const outcome = outcomes.shift() ?? 'ok';
        calls.push(outcome);
        if (outcome === 'throw') throw new Error('the form never rendered');
        return { filled: ['amount'], manual: [], url: 'https://example.com' };
      },
      async waitForConfirmation() {
        const last = calls[calls.length - 1];
        return last === 'ok'
          ? { ok: true, note: 'confirmed' }
          : { ok: false, note: 'timed out waiting for the confirmation page' };
      },
    },
  };
}

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-run-'));
  return new Ledger(path.join(dir, 'ledger.jsonl'));
}

const run = (recipients, outcomes, overrides = {}) => {
  const { driver, calls } = fakeDriver(outcomes);
  const browser = fakeBrowser();
  const ledger = tempLedger();
  return {
    calls,
    browser,
    ledger,
    promise: executeDonations({
      recipients,
      config: { ...CONFIG, ...overrides },
      paths: { browserProfileDir: '/tmp/unused', debugDir: '/tmp/unused' },
      card: CARD,
      ledger,
      browser,
      resolveDriver: () => driver,
    }),
  };
};

test('a confirmed donation is recorded as spent', async () => {
  const { promise, ledger } = run([recipient(1)], ['ok']);
  const { results, aborted } = await promise;

  assert.equal(aborted, false);
  assert.equal(results[0].status, STATUS.SUCCESS);
  assert.equal(results[0].amount, 10);
  assert.equal(ledger.spentSince(new Date(Date.now() - 60_000)), 10);
});

test('a failed donation records zero, so it cannot consume budget', async () => {
  const { promise, ledger } = run([recipient(1)], ['no', 'no', 'no']);
  const { results } = await promise;

  assert.equal(results[0].status, STATUS.FAILED);
  assert.equal(results[0].amount, 0);
  assert.equal(ledger.spentSince(new Date(Date.now() - 60_000)), 0);
});

test('a recipient is retried up to the configured number of times', async () => {
  const { promise, calls } = run([recipient(1)], ['no', 'no', 'ok']);
  const { results } = await promise;

  assert.equal(calls.length, 3, 'first attempt plus two retries');
  assert.equal(results[0].status, STATUS.SUCCESS);
});

test('retries stop once they are exhausted', async () => {
  const { promise, calls } = run([recipient(1)], ['no', 'no', 'no', 'no']);
  await promise;
  assert.equal(calls.length, 3);
});

test('a driver that throws is retried like any other failure', async () => {
  const { promise, calls } = run([recipient(1)], ['throw', 'ok']);
  const { results } = await promise;

  assert.equal(calls.length, 2);
  assert.equal(results[0].status, STATUS.SUCCESS);
});

test('the run stops after too many recipients fail in a row', async () => {
  const recipients = [recipient(1), recipient(2), recipient(3), recipient(4)];
  // Every attempt fails: 3 recipients x 3 attempts reaches the abort threshold.
  const { promise } = run(recipients, Array(20).fill('no'), { maxConsecutiveFailures: 3 });
  const { results, aborted, reason } = await promise;

  assert.equal(aborted, true);
  assert.match(reason, /consecutive failures/);
  assert.equal(results.length, 3, 'the fourth recipient is never attempted');
});

test('a success resets the consecutive failure count', async () => {
  const recipients = [recipient(1), recipient(2), recipient(3)];
  const outcomes = [
    'no', 'no', 'no', // recipient 1 fails
    'ok', //             recipient 2 succeeds, resetting the count
    'no', 'no', 'no', // recipient 3 fails
  ];
  const { promise } = run(recipients, outcomes, { maxConsecutiveFailures: 2 });
  const { results, aborted } = await promise;

  assert.equal(aborted, false, 'two failures either side of a success is not a streak');
  assert.deepEqual(
    results.map((r) => r.status),
    [STATUS.FAILED, STATUS.SUCCESS, STATUS.FAILED],
  );
});

test('a recipient on an undrivable platform is skipped, not failed', async () => {
  const browser = fakeBrowser();
  const ledger = tempLedger();
  const { results, aborted } = await executeDonations({
    recipients: [recipient(1), recipient(2)],
    config: CONFIG,
    paths: { browserProfileDir: '/tmp/unused', debugDir: '/tmp/unused' },
    card: CARD,
    ledger,
    browser,
    resolveDriver: () => null,
  });

  assert.equal(aborted, false, 'a skip is not a failure and must not trip the abort rule');
  assert.deepEqual(
    results.map((r) => r.status),
    [STATUS.SKIPPED, STATUS.SKIPPED],
  );
  assert.equal(ledger.spentSince(new Date(Date.now() - 60_000)), 0);
});

test('the browser is closed even when the run aborts', async () => {
  const { promise, browser } = run([recipient(1), recipient(2), recipient(3)], Array(20).fill('no'), {
    maxConsecutiveFailures: 1,
  });
  await promise;
  assert.equal(browser.closed, true);
});

test('the ledger never records the card', async () => {
  const { promise, ledger } = run([recipient(1)], ['ok']);
  await promise;
  assert.ok(!JSON.stringify(ledger.all()).includes('4111'));
});
