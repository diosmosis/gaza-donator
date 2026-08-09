/**
 * The progress line as `plan` and `donate` use it: work measured in shortlist
 * places filled, with output that has to coexist with the line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Progress } from '../src/progress.js';

const CLEAR = `\r[2K`;

function fakeStream(columns = 100) {
  const written = [];
  return {
    written,
    columns,
    isTTY: false,
    write(text) {
      written.push(text);
      return true;
    },
  };
}

function clock(start = 0) {
  let at = start;
  const now = () => at;
  now.advance = (ms) => {
    at += ms;
  };
  return now;
}

test('a skip counts but does not advance the bar', () => {
  // A candidate that fails verification does not fill a shortlist place, and
  // counting it as done would run the bar past the end.
  const stream = fakeStream();
  const progress = new Progress({
    total: 3,
    stream,
    tty: true,
    now: clock(),
    problemWord: 'passed over',
    zeroWord: 'none passed over',
  });

  progress.tick({ label: '@a@x' });
  progress.skip({ label: '@b@x' });
  progress.skip({ label: '@c@x' });

  const line = stream.written.at(-1);
  assert.match(line, /\[1\/3\]/, 'one place filled');
  assert.match(line, /2 passed over/);
});

test('the caller chooses what the counter is called', () => {
  const stream = fakeStream();
  const progress = new Progress({
    total: 2,
    stream,
    tty: true,
    now: clock(),
    problemWord: 'passed over',
    zeroWord: 'none passed over',
  });

  progress.tick({});
  assert.match(stream.written.at(-1), /none passed over/);
});

test('a status update redraws the terminal line but logs nothing when redirected', () => {
  const tty = fakeStream();
  const terminal = new Progress({ total: 3, stream: tty, tty: true, now: clock() });
  terminal.status('checking @a@x');
  assert.match(tty.written.at(-1), /checking @a@x/);

  const file = fakeStream();
  const redirected = new Progress({ total: 3, stream: file, tty: false, now: clock() });
  redirected.status('checking @a@x');
  assert.equal(file.written.length, 0, 'a line per item is a log nobody wants');
});

test('a stalled count does not become a line per attempt when redirected', () => {
  const now = clock();
  const stream = fakeStream();
  const progress = new Progress({ total: 10, stream, tty: false, everyMs: 10_000, now });

  // Ten failures in a row: `done` never moves, and neither should the log.
  for (let i = 0; i < 10; i += 1) progress.skip({ label: `@${i}@x` });
  assert.equal(stream.written.length, 1, 'the first one, then silence until the interval');

  now.advance(11_000);
  progress.skip({ label: '@late@x' });
  assert.equal(stream.written.length, 2);
});

test('output during a run is printed above the line, not through it', () => {
  const stream = fakeStream();
  const progress = new Progress({ total: 2, stream, tty: true, now: clock() });
  progress.tick({ label: '@a@x' });

  const printed = [];
  progress.around(() => printed.push('a warning'));

  assert.deepEqual(printed, ['a warning']);
  assert.equal(stream.written.at(-2), CLEAR, 'the line is cleared first');
  assert.match(stream.written.at(-1), /@a@x/, 'and redrawn afterwards');
});

test('around() just prints when there is no line to protect', () => {
  const stream = fakeStream();
  const progress = new Progress({ total: 2, stream, tty: false, now: clock() });

  const printed = [];
  progress.around(() => printed.push('a warning'));
  assert.deepEqual(printed, ['a warning']);
  assert.equal(stream.written.length, 0);
});
