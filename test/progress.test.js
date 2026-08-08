import test from 'node:test';
import assert from 'node:assert/strict';
import { Progress, formatDuration } from '../src/progress.js';

/** Collects what would have been written to the terminal. */
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
    get text() {
      return written.join('');
    },
  };
}

/** A clock that only moves when the test says so. */
function clock(start = 0) {
  let at = start;
  const now = () => at;
  now.advance = (ms) => {
    at += ms;
  };
  return now;
}

test('a terminal gets one line, rewritten', () => {
  const stream = fakeStream();
  const progress = new Progress({ total: 3, stream, tty: true, now: clock() });

  progress.tick({ label: '@a@x' });
  progress.tick({ label: '@b@x' });

  assert.equal(stream.written.length, 2);
  assert.equal(stream.written.every((line) => line.startsWith('\r')), true, 'rewrites in place');
  assert.equal(stream.text.includes('\n'), false, 'and never scrolls');
  assert.match(stream.written[1], /\[2\/3\]\s+66%/);
});

test('a redirected run gets periodic lines instead of carriage returns', () => {
  const now = clock();
  const stream = fakeStream();
  const progress = new Progress({ total: 100, stream, tty: false, everyMs: 10_000, now });

  progress.tick({ label: '@a@x' });
  progress.tick({ label: '@b@x' });
  assert.equal(stream.written.length, 1, 'not one line per item');

  now.advance(11_000);
  progress.tick({ label: '@c@x' });
  assert.equal(stream.written.length, 2);
  assert.equal(stream.written.every((line) => line.endsWith('\n')), true);
});

test('problems are counted as they happen, so a long run shows them early', () => {
  const stream = fakeStream();
  const progress = new Progress({ total: 4, stream, tty: true, now: clock() });

  progress.tick({ ok: true });
  assert.match(stream.written.at(-1), /no problems/);

  progress.tick({ ok: false });
  progress.tick({ ok: false });
  assert.match(stream.written.at(-1), /2 problem\(s\)/);
});

test('the estimate comes from the pace so far', () => {
  const now = clock();
  const stream = fakeStream();
  const progress = new Progress({ total: 10, stream, tty: true, now });

  now.advance(60_000);
  progress.tick({}); // 1 of 10 in a minute, so about nine minutes left
  assert.match(stream.written.at(-1), /~9m00s left/);
});

test('the line is kept inside the terminal, so it does not wrap', () => {
  const stream = fakeStream(40);
  const progress = new Progress({ total: 10, stream, tty: true, now: clock() });

  progress.tick({ label: '@a-very-long-account-name@some.instance.example' });
  const line = stream.written.at(-1).replace('\r', '').replace('[2K', '');
  assert.ok(line.length <= 39, `line was ${line.length} columns`);
});

test('finishing clears the line so the report starts clean', () => {
  const stream = fakeStream();
  const progress = new Progress({ total: 2, stream, tty: true, now: clock() });

  progress.tick({});
  progress.finish();
  assert.equal(stream.written.at(-1), '\r[2K');
});

test('finishing a redirected run prints a final line instead', () => {
  const stream = fakeStream();
  const progress = new Progress({ total: 2, stream, tty: false, now: clock() });

  progress.finish();
  assert.match(stream.written.at(-1), /\[0\/2\].*done\n/);
});

test('durations read as durations', () => {
  assert.equal(formatDuration(900), '1s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m30s');
  assert.equal(formatDuration(3_600_000 + 120_000), '1h02m');
});
