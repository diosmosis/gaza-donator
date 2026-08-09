/**
 * "Press Enter once you are past the challenge."
 *
 * Two things can end that wait — the form appearing, or the person saying so —
 * and the loser has to be called off. A readline left open on stdin keeps the
 * whole process alive after the run has printed its summary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitPastGate } from '../src/gates.js';

/** A page whose element appears after `appearsAfter` lookups. */
function fakePage(appearsAfter) {
  let looks = 0;
  return {
    get looks() {
      return looks;
    },
    async $() {
      looks += 1;
      return looks > appearsAfter ? { dispose: async () => {} } : null;
    },
  };
}

/** A prompt the test can answer, or watch being cancelled. */
function fakePrompt() {
  let answer;
  let cancelled = false;
  const promise = new Promise((resolve) => {
    answer = resolve;
  });
  const confirmGate = () => {
    confirmGate.offered += 1;
    return {
      promise,
      cancel: () => {
        cancelled = true;
      },
    };
  };
  confirmGate.offered = 0;
  confirmGate.press = () => answer(true);
  Object.defineProperty(confirmGate, 'cancelled', { get: () => cancelled });
  return confirmGate;
}

const GATE = { kind: 'cloudflare-turnstile', marker: 'challenge frame challenges.cloudflare.com' };

test('no gate, no prompt: a page that opened normally asks for nothing', async () => {
  const confirmGate = fakePrompt();
  const handle = await waitPastGate(fakePage(1), ['#amount'], {
    gate: null,
    confirmGate,
    timeoutMs: 5000,
  });

  assert.ok(handle);
  assert.equal(confirmGate.offered, 0);
});

test('a gate offers the prompt', async () => {
  const confirmGate = fakePrompt();
  await waitPastGate(fakePage(1), ['#amount'], { gate: GATE, confirmGate, timeoutMs: 5000 });

  assert.equal(confirmGate.offered, 1);
});

test('the form appearing on its own ends the wait, and the prompt is called off', async () => {
  // Clearing the challenge is usually enough by itself; nobody should have to
  // press Enter to be allowed to continue.
  const confirmGate = fakePrompt();
  const handle = await waitPastGate(fakePage(2), ['#amount'], {
    gate: GATE,
    confirmGate,
    timeoutMs: 10_000,
  });

  assert.ok(handle, 'found without anyone pressing anything');
  assert.equal(confirmGate.cancelled, true, 'the readline is closed, so the run can exit');
});

test('pressing Enter ends the wait even if the form is slow to appear', async () => {
  // The person has just done something the page has not caught up with yet.
  const page = fakePage(6);
  const confirmGate = fakePrompt();

  const waiting = waitPastGate(page, ['#amount'], {
    gate: GATE,
    confirmGate,
    timeoutMs: 60_000,
    graceMs: 10_000,
  });

  setTimeout(() => confirmGate.press(), 5);
  assert.ok(await waiting, 'the grace period found it');
});

test('Enter on a page that never shows the form gives up rather than waiting on', async () => {
  const confirmGate = fakePrompt();
  const logged = [];

  const waiting = waitPastGate(fakePage(Number.POSITIVE_INFINITY), ['#amount'], {
    gate: GATE,
    confirmGate,
    timeoutMs: 600_000,
    graceMs: 40,
    log: (message) => logged.push(message),
  });

  setTimeout(() => confirmGate.press(), 5);

  assert.equal(await waiting, null, 'not another ten minutes of waiting');
  assert.match(logged.join('\n'), /looking for the form/);
  assert.equal(confirmGate.cancelled, true);
});

test('the prompt is called off even when the wait times out', async () => {
  const confirmGate = fakePrompt();
  await waitPastGate(fakePage(Number.POSITIVE_INFINITY), ['#amount'], {
    gate: GATE,
    confirmGate,
    timeoutMs: 30,
  });

  assert.equal(confirmGate.cancelled, true);
});

test('with no way to ask — a scheduled run — the page is still watched', async () => {
  const handle = await waitPastGate(fakePage(2), ['#amount'], {
    gate: GATE,
    confirmGate: null,
    timeoutMs: 10_000,
  });
  assert.ok(handle);
});
