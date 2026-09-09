/**
 * Keeping a minimum gap between requests to one site.
 *
 * The crawl's concurrency is across the roster; this is per host. A roster that
 * is mostly Chuffed means concurrency four is four simultaneous requests to
 * Chuffed for the length of the run, and Chuffed answers a burst of that by
 * refusing to serve its payment pages — on the very pages the donation step
 * needs. The clock is injected so none of this is measured in real seconds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPacer } from '../src/pace.js';

/**
 * A hand-wound clock.
 *
 * `sleep` records what it was asked to wait and returns without moving time,
 * because real waits overlap: four callers sleeping at once do not take four
 * times as long, and a clock that adds them up would report queueing that
 * never happened. Time moves only when a test says so.
 */
function fakeClock() {
  let at = 0;
  const slept = [];
  return {
    slept,
    now: () => at,
    sleep: async (ms) => {
      slept.push(ms);
    },
    advance: (ms) => {
      at += ms;
    },
  };
}

test('the first request to a host goes straight through', async () => {
  const clock = fakeClock();
  const pace = createPacer({ minGapMs: 750, now: clock.now, sleep: clock.sleep });

  assert.equal(await pace('https://www.chuffed.org/project/x'), 0);
});

test('a second request to the same host waits out the gap', async () => {
  const clock = fakeClock();
  const pace = createPacer({ minGapMs: 750, now: clock.now, sleep: clock.sleep });

  await pace('https://www.chuffed.org/project/x');
  assert.equal(await pace('https://www.chuffed.org/pay/campaign/y'), 750, 'same site, so it queues');
});

test('a different host is not made to wait behind it', async () => {
  // Pacing per host is the whole point: a mixed roster keeps full speed.
  const clock = fakeClock();
  const pace = createPacer({ minGapMs: 750, now: clock.now, sleep: clock.sleep });

  await pace('https://www.chuffed.org/project/x');
  assert.equal(await pace('https://www.gofundme.com/f/y'), 0);
});

test('www is not a different site', async () => {
  const clock = fakeClock();
  const pace = createPacer({ minGapMs: 500, now: clock.now, sleep: clock.sleep });

  await pace('https://chuffed.org/project/x');
  assert.equal(await pace('https://www.chuffed.org/project/y'), 500);
});

test('requests that arrive together queue rather than all taking the same slot', async () => {
  // The slot is claimed before awaiting. Without that, four callers starting at
  // once would each see the host free and all go at once — which is the burst
  // this exists to prevent.
  const clock = fakeClock();
  const pace = createPacer({ minGapMs: 300, now: clock.now, sleep: clock.sleep });

  const waits = await Promise.all([
    pace('https://www.chuffed.org/a'),
    pace('https://www.chuffed.org/b'),
    pace('https://www.chuffed.org/c'),
    pace('https://www.chuffed.org/d'),
  ]);

  assert.deepEqual(waits, [0, 300, 600, 900], 'spaced one gap apart, in order');
});

test('a host left alone long enough is not held back at all', async () => {
  // Nothing is ever pushed further back than it needs to be.
  const clock = fakeClock();
  const pace = createPacer({ minGapMs: 750, now: clock.now, sleep: clock.sleep });

  await pace('https://www.chuffed.org/a');
  clock.advance(5000);
  assert.equal(await pace('https://www.chuffed.org/b'), 0);
});

test('an unparseable url is still paced rather than throwing', async () => {
  const clock = fakeClock();
  const pace = createPacer({ minGapMs: 200, now: clock.now, sleep: clock.sleep });

  assert.equal(await pace('not a url'), 0);
  assert.equal(await pace('not a url'), 200);
});

test('pacing can be turned off', async () => {
  const clock = fakeClock();
  const pace = createPacer({ minGapMs: 0, now: clock.now, sleep: clock.sleep });

  await pace('https://www.chuffed.org/a');
  assert.equal(await pace('https://www.chuffed.org/b'), 0);
});
