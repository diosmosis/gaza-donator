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
  const prepared = [];
  return {
    calls,
    prepared,
    driver: {
      id: 'fake',
      async prepare(page, options) {
        const outcome = outcomes.shift() ?? 'ok';
        calls.push(outcome);
        prepared.push(options);
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
  const { driver, calls, prepared } = fakeDriver(outcomes);
  const browser = fakeBrowser();
  const ledger = tempLedger();
  return {
    calls,
    prepared,
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

test('the configured tip is handed to the driver and charged to the budget', async () => {
  const { promise, prepared, ledger } = run([recipient(1)], ['ok'], { tipAmount: 2 });
  const { results } = await promise;

  assert.equal(prepared[0].amount, 10);
  assert.equal(prepared[0].tip, 2, 'the driver is told what to put in the tip field');
  assert.equal(results[0].amount, 10, 'the recipient still gets the donation amount');
  assert.equal(results[0].tip, 2);
  assert.equal(ledger.spentSince(new Date(Date.now() - 60_000)), 12, 'the card was charged both');
});

test('no tip is charged when none is configured', async () => {
  const { promise, prepared, ledger } = run([recipient(1)], ['ok']);
  await promise;

  assert.equal(prepared[0].tip, 0);
  assert.equal(ledger.spentSince(new Date(Date.now() - 60_000)), 10);
});

test('a failed donation records no tip either', async () => {
  const { promise, ledger } = run([recipient(1)], ['no', 'no', 'no'], { tipAmount: 2 });
  const { results } = await promise;

  assert.equal(results[0].tip ?? 0, 0);
  assert.equal(ledger.spentSince(new Date(Date.now() - 60_000)), 0);
});

test('the ledger never records the card', async () => {
  const { promise, ledger } = run([recipient(1)], ['ok']);
  await promise;
  assert.ok(!JSON.stringify(ledger.all()).includes('4111'));
});

test('the payment step is given the run\'s full human timeout, not a shorter one of its own', async () => {
  // The gated page can sit for minutes while a person clears a challenge; the
  // driver has to be told how long it is allowed to wait for them.
  const { promise, prepared } = run([recipient(1)], ['ok'], { donationTimeoutMs: 420_000 });
  await promise;

  assert.equal(prepared[0].timeoutMs, 420_000);
});

test('a tab the user closed is skipped, not retried', async () => {
  // Closing the window means the donation is done, or that this one is being
  // passed over deliberately. Reopening a payment page for it would be wrong
  // in both readings.
  let attempts = 0;
  const browser = fakeBrowser();
  const ledger = tempLedger();

  const { results, aborted } = await executeDonations({
    recipients: [recipient(1), recipient(2)],
    config: CONFIG,
    paths: { browserProfileDir: '/tmp/unused', debugDir: '/tmp/unused' },
    card: CARD,
    ledger,
    browser,
    resolveDriver: () => ({
      id: 'fake',
      async prepare() {
        attempts += 1;
        return { filled: ['amount'], manual: [], url: 'https://example.com' };
      },
      async waitForConfirmation() {
        return { ok: false, closed: true, note: 'the tab was closed' };
      },
    }),
  });

  assert.equal(attempts, 2, 'one attempt each, no retries');
  assert.deepEqual(
    results.map((r) => r.status),
    [STATUS.SKIPPED, STATUS.SKIPPED],
  );
  assert.equal(aborted, false, 'and it does not count towards the abort rule');
  assert.equal(ledger.spentSince(new Date(Date.now() - 60_000)), 0);
});

test('a tab closed mid-fill is skipped rather than retried', async () => {
  let attempts = 0;
  const { promise, ledger } = (() => {
    const browser = fakeBrowser();
    const ledger = tempLedger();
    return {
      ledger,
      promise: executeDonations({
        recipients: [recipient(1)],
        config: CONFIG,
        paths: { browserProfileDir: '/tmp/unused', debugDir: '/tmp/unused' },
        card: CARD,
        ledger,
        browser,
        resolveDriver: () => ({
          id: 'fake',
          async prepare() {
            attempts += 1;
            throw new Error('Protocol error (Runtime.callFunctionOn): Target closed.');
          },
          async waitForConfirmation() {
            return { ok: true, note: 'never reached' };
          },
        }),
      }),
    };
  })();

  const { results } = await promise;
  assert.equal(attempts, 1, 'the driver is not called again');
  assert.equal(results[0].status, STATUS.SKIPPED);
  assert.equal(ledger.spentSince(new Date(Date.now() - 60_000)), 0);
});
