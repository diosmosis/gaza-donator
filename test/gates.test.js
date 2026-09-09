/**
 * Recognising bot gates, and the log of the unexpected ones.
 *
 * The detector has to be specific: a false positive means a live campaign is
 * reported as blocked and quietly passed over, which is the same harm the
 * feature exists to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { GateLog, detectGate, isClearable, summariseGates } from '../src/gates.js';

const tempFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gates-')), 'gates.jsonl');

test('a challenge iframe is a gate whatever the page says', () => {
  const gate = detectGate({
    status: 200,
    text: 'Support this campaign',
    frameUrls: ['https://www.chuffed.org/', 'https://challenges.cloudflare.com/turnstile/v0/api.js'],
  });

  assert.equal(gate.kind, 'cloudflare-turnstile');
  assert.match(gate.marker, /challenges\.cloudflare\.com/);
});

test('the usual interstitials are recognised by their wording', () => {
  const cases = [
    ['Just a moment...', 'cloudflare'],
    ['Checking your browser before accessing chuffed.org', 'cloudflare'],
    ['Enable JavaScript and cookies to continue', 'cloudflare'],
    ['Verify you are human by completing the action below', 'challenge'],
    ['Press and hold to confirm you are a human', 'press-and-hold'],
    ['Pardon Our Interruption', 'bot-wall'],
    ['Access denied', 'bot-wall'],
  ];

  for (const [text, kind] of cases) {
    const gate = detectGate({ status: 200, text });
    assert.equal(gate?.kind, kind, `expected "${text}" to be a ${kind} gate`);
  }
});

test('a blocked status is a gate even with nothing else to go on', () => {
  assert.equal(detectGate({ status: 403, text: '' }).kind, 'blocked-status');
  assert.equal(detectGate({ status: 429, text: '' }).marker, 'HTTP 429');
  assert.equal(detectGate({ status: 503, text: '' }).kind, 'blocked-status');
});

test('an ordinary campaign page is not a gate', () => {
  // These pages talk about security, verification and helping humans all the
  // time; only interstitial wording counts.
  const pages = [
    'Help my family survive. We are verified by Gaza Verified. Donate now.',
    'Security situation update: we had to move again this week.',
    'Thank you to every human being who has helped us so far.',
    'Verified fundraiser · $3,439 raised of $10,000',
  ];

  for (const text of pages) {
    assert.equal(detectGate({ status: 200, text }), null, text);
  }
});

test('a 404 is a dead campaign, not a gate', () => {
  // The difference matters: one is the campaign's own state, the other is
  // something standing between us and it.
  assert.equal(detectGate({ status: 404, text: 'Page Not Found' }), null);
});

test('a gate is recorded with where and when it happened', () => {
  const file = tempFile();
  const log = new GateLog(file);

  const record = log.record({
    stage: 'plan',
    fqn: '@someone@x',
    platform: 'chuffed',
    url: 'https://www.chuffed.org/project/x',
    kind: 'cloudflare',
    marker: 'just a moment',
  });

  assert.ok(Date.parse(record.at) > 0);
  assert.equal(log.all().length, 1);
  assert.equal(log.all()[0].url, 'https://www.chuffed.org/project/x');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('the log survives a killed run mid-line', () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ at: new Date().toISOString(), kind: 'cloudflare', url: 'x' })}\n{"at":"20`,
  );

  const log = new GateLog(file);
  assert.equal(log.all().length, 1);
});

test('a dry run keeps gates in memory rather than writing them', () => {
  const file = tempFile();
  const log = new GateLog(file, { readOnly: true });
  log.record({ stage: 'plan', url: 'x', kind: 'cloudflare', marker: 'm' });

  assert.equal(log.all().length, 1);
  assert.equal(fs.existsSync(file), false);
});

test('gates are grouped by kind, platform and stage, most recent first', () => {
  const groups = summariseGates([
    { at: '2026-08-01T00:00:00Z', kind: 'cloudflare', platform: 'chuffed', stage: 'plan', url: 'a' },
    { at: '2026-08-02T00:00:00Z', kind: 'cloudflare', platform: 'chuffed', stage: 'plan', url: 'b' },
    { at: '2026-08-03T00:00:00Z', kind: 'press-and-hold', platform: 'gofundme', stage: 'check', url: 'c' },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].kind, 'press-and-hold', 'most recently seen first');
  assert.equal(groups[1].count, 2);
  assert.deepEqual(groups[1].examples, ['a', 'b']);
  assert.equal(groups[1].first, '2026-08-01T00:00:00Z');
  assert.equal(groups[1].last, '2026-08-02T00:00:00Z');
});

test('the same page seen twice is one group with one example', () => {
  const groups = summariseGates([
    { at: '2026-08-01T00:00:00Z', kind: 'cloudflare', platform: 'chuffed', stage: 'plan', url: 'a' },
    { at: '2026-08-02T00:00:00Z', kind: 'cloudflare', platform: 'chuffed', stage: 'plan', url: 'a' },
  ]);

  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].examples, ['a']);
});

test('Chuffed turning us away is a gate, and not one a person can clear', () => {
  // Captured from a real pay page. Chuffed serves this as an ordinary 200 with
  // the donation form replaced by one sentence — no Cloudflare, no challenge
  // widget, nothing to solve. Before it was recognised the run waited out the
  // donor's entire five-minute timeout for a form that was never coming, then
  // blamed the markup and wrote nothing to the gate log.
  const html = readFileSync(new URL('./fixtures/chuffed-suspicious.html', import.meta.url), 'utf8');
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  const gate = detectGate({ status: 200, text, title: 'Payment | Chuffed' });

  assert.equal(gate?.kind, 'rate-limited');
  assert.equal(isClearable(gate), false, 'nobody can click their way past a rate limiter');
});

test('a challenge someone can actually solve is still worth waiting for', () => {
  // The distinction has to hold in both directions, or the assisted flow stops
  // waiting on the Turnstile it was built around.
  assert.equal(isClearable(detectGate({ text: 'Verify you are human' })), true);
  assert.equal(isClearable(detectGate({ frameUrls: ['https://challenges.cloudflare.com/x'] })), true);

  // A hard block is not solvable either.
  assert.equal(isClearable(detectGate({ status: 429 })), false);
  assert.equal(isClearable(null), false, 'no gate is not a clearable gate');
});
