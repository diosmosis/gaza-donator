/**
 * Waiting for a person to clear a challenge.
 *
 * This is the step that decides whether an assisted donation works at all: the
 * form appears the instant the challenge clears, and if nothing is watching by
 * then, the run stalls with a blank form and no explanation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForHuman } from '../src/browser.js';

/** A page whose element shows up after `appearsAfter` lookups. */
function fakePage(appearsAfter) {
  let looks = 0;
  return {
    get looks() {
      return looks;
    },
    async $(selector) {
      looks += 1;
      return looks > appearsAfter ? { selector, dispose: async () => {} } : null;
    },
  };
}

test('the form is picked up as soon as it appears', async () => {
  const page = fakePage(3);
  const handle = await waitForHuman(page, ['#amount'], { timeoutMs: 60_000 });

  assert.ok(handle, 'found once the challenge cleared');
  assert.equal(handle.selector, '#amount');
});

test('waiting is measured in human time, not in page time', async () => {
  // An earlier version gave up after 90 seconds — silently — and then never
  // looked again, so clearing the challenge at two minutes did nothing at all.
  const page = fakePage(Number.POSITIVE_INFINITY);
  const logged = [];
  let at = 0;
  const now = () => at;

  const waiting = waitForHuman(page, ['#amount'], {
    timeoutMs: 300_000,
    nagMs: 30_000,
    log: (message) => logged.push(message),
    now,
  });

  // Let the loop run, advancing the clock past several nags.
  for (let i = 0; i < 40 && logged.length < 3; i += 1) {
    at += 30_000;
    await new Promise((resolve) => setImmediate(resolve));
  }

  at = 400_000;
  assert.equal(await waiting, null, 'and it does eventually stop');
  assert.ok(logged.length >= 1, 'having said what it was waiting for');
  assert.match(logged[0], /still waiting for the form/);
  assert.match(logged[0], /left/, 'with how long is left');
});

test('it keeps looking for the whole window rather than checking once', async () => {
  // The challenge takes as long as it takes; one look would be a coin toss.
  const page = fakePage(20);
  const handle = await waitForHuman(page, ['#amount'], { timeoutMs: 60_000 });

  assert.ok(handle);
  assert.ok(page.looks > 20, `looked ${page.looks} times`);
});

test('a page that never shows the form returns null instead of hanging', async () => {
  const page = fakePage(Number.POSITIVE_INFINITY);
  const handle = await waitForHuman(page, ['#amount'], { timeoutMs: 30 });
  assert.equal(handle, null);
});
