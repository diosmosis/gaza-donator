/**
 * Noticing bot gates, and keeping a record of the ones that turn up somewhere
 * they were not expected.
 *
 * One gate is part of the design: Chuffed's payment page is behind a Cloudflare
 * Turnstile challenge, which is exactly why donating is assisted. Everywhere
 * else — campaign pages during `plan`, the whole roster during `check` — a
 * challenge is news. It looks identical to a page whose markup changed (we
 * simply do not find what we are looking for), so without naming it, a gate
 * gets misfiled as "the selector rotted" or, worse, as "this campaign is
 * closed" and the person is quietly dropped.
 *
 * The log is append-only JSONL next to the ledger, so a challenge seen at 3am
 * in a cron run is still there to read afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.js';
import { findFirst, waitForHuman } from './browser.js';

/**
 * Frames that only ever exist to run a challenge. A page that loads one of
 * these is gated whatever its text says.
 */
const CHALLENGE_FRAMES = [
  [/challenges\.cloudflare\.com/i, 'cloudflare-turnstile'],
  [/hcaptcha\.com/i, 'hcaptcha'],
  [/recaptcha\/(api2|enterprise)/i, 'recaptcha'],
  [/captcha-delivery\.com/i, 'datadome'],
  [/px-cdn\.net|perimeterx/i, 'perimeterx'],
  [/geo\.captcha-delivery|arkoselabs\.com/i, 'arkose'],
];

/**
 * Phrases challenge pages use. Deliberately specific: a campaign page can
 * legitimately talk about "verification" or "security", so only wording that
 * belongs to an interstitial counts.
 */
const CHALLENGE_TEXT = [
  [/just a moment/i, 'cloudflare'],
  [/checking your browser before accessing/i, 'cloudflare'],
  [/enable javascript and cookies to continue/i, 'cloudflare'],
  [/verify you are human/i, 'challenge'],
  [/verifying you are human/i, 'challenge'],
  [/are you a robot/i, 'challenge'],
  [/i am not a robot/i, 'recaptcha'],
  [/press (?:and hold|&amp; hold)/i, 'press-and-hold'],
  [/pardon our interruption/i, 'bot-wall'],
  [/unusual traffic from your (?:computer )?network/i, 'bot-wall'],
  [/your request has been blocked/i, 'bot-wall'],
  [/access (?:to this page has been )?denied/i, 'bot-wall'],
  [/why have i been blocked/i, 'bot-wall'],
  [/ray id/i, 'cloudflare'],
  // Chuffed's own rate limiter, served as an ordinary 200 with the payment
  // form replaced by this sentence. Not Cloudflare, not a challenge, and not
  // the campaign being closed — see UNCLEARABLE.
  [/(?:noticed|detected) suspicious activity/i, 'rate-limited'],
];

/**
 * Gates there is no point putting a person in front of.
 *
 * Every other kind here is a puzzle someone at the keyboard can solve, so the
 * assisted flow says "clear it and we'll carry on" and waits. These two are
 * not: a rate limiter and a hard block are the site declining to serve this
 * visitor for a while, and no amount of clicking changes that. Waiting on them
 * spends the donor's whole timeout — five silent minutes by default — before
 * reporting something that was knowable at once.
 */
const UNCLEARABLE = new Set(['rate-limited', 'blocked-status']);

/**
 * Can a person at the browser actually get past this one?
 *
 * @param {{kind: string}|null} gate
 */
export function isClearable(gate) {
  return Boolean(gate) && !UNCLEARABLE.has(gate.kind);
}

/** Statuses that a normal campaign page never returns. */
const BLOCKED_STATUSES = new Set([401, 403, 429, 503]);

/**
 * Decide whether what we loaded is a gate rather than the page we asked for.
 *
 * @param {object} evidence
 * @param {number} [evidence.status]     HTTP status
 * @param {string} [evidence.text]       visible page text
 * @param {string} [evidence.title]
 * @param {string[]} [evidence.frameUrls]
 * @returns {{kind: string, marker: string}|null}
 */
export function detectGate({ status = 0, text = '', title = '', frameUrls = [] } = {}) {
  for (const url of frameUrls) {
    for (const [pattern, kind] of CHALLENGE_FRAMES) {
      if (pattern.test(url)) return { kind, marker: `challenge frame ${shorten(url)}` };
    }
  }

  const haystack = `${title}\n${text}`;
  for (const [pattern, kind] of CHALLENGE_TEXT) {
    const found = haystack.match(pattern);
    if (found) return { kind, marker: found[0].toLowerCase().trim() };
  }

  // A blocked status with nothing else to go on is still a gate: it is not the
  // page, and it is not the campaign being closed either.
  if (BLOCKED_STATUSES.has(status)) {
    return { kind: 'blocked-status', marker: `HTTP ${status}` };
  }

  return null;
}

/**
 * Gather the evidence `detectGate` needs from a live page.
 *
 * @param {import('puppeteer').Page} page
 * @param {object} [options]
 * @param {number} [options.status] the navigation's HTTP status
 */
export async function detectGateOnPage(page, { status = 0 } = {}) {
  const evidence = { status, frameUrls: [], text: '', title: '' };

  try {
    evidence.frameUrls = page.frames().map((frame) => frame.url());
  } catch {
    // a page that is closing has no frames; the text check still applies
  }
  try {
    evidence.title = await page.title();
  } catch {
    /* ignore */
  }
  try {
    evidence.text = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '');
  } catch {
    /* ignore */
  }

  return detectGate(evidence);
}

/**
 * A gate, but only if it is actually in the way.
 *
 * Presence of a challenge widget proves nothing: Chuffed's payment page keeps
 * its Turnstile iframe in the DOM after it has passed, so a browser carrying
 * clearance renders the form *and* still shows the frame. Announcing a
 * challenge there is worse than saying nothing — it asks a person to clear
 * something that is not in front of them.
 *
 * So the question is never "is there a challenge?" but "is what we need
 * missing, and is a challenge why?".
 *
 * @param {import('puppeteer').Page} page
 * @param {string[]} selectors what the page is supposed to give us
 * @param {object} [options]
 * @param {number} [options.status]    the navigation's HTTP status
 * @param {number} [options.timeoutMs] how long to look before concluding it is missing
 * @returns {Promise<{kind: string, marker: string}|null>}
 */
export async function gateIfBlocking(page, selectors, { status = 0, timeoutMs = 5000 } = {}) {
  const handle = await findFirst(page, selectors, { timeoutMs, visible: false });
  if (handle) {
    await handle.dispose();
    return null;
  }
  return detectGateOnPage(page, { status });
}

/**
 * Wait for something that a challenge is standing in front of.
 *
 * Two things can end the wait, and both must be able to: the element turning up
 * on its own (the page is watched continuously, so clearing the challenge is
 * usually enough), or the person saying they are through. The prompt is offered
 * only when a gate was actually seen — asking "press Enter" on a page that
 * opened normally would be a step for nothing.
 *
 * @param {import('puppeteer').Page} page
 * @param {string[]} selectors
 * @param {object} options
 * @param {object|null} options.gate            from detectGate
 * @param {() => {promise: Promise, cancel: () => void}} [options.confirmGate]
 * @returns {Promise<import('puppeteer').ElementHandle|null>}
 */
export async function waitPastGate(
  page,
  selectors,
  { gate = null, confirmGate = null, ...options } = {},
) {
  const prompt = gate && confirmGate ? confirmGate() : null;
  try {
    return await waitForHuman(page, selectors, { ...options, ready: prompt?.promise });
  } finally {
    // Whoever lost the race has to be called off: a readline left open on stdin
    // keeps the process alive long after the run has printed its summary.
    prompt?.cancel();
  }
}

function shorten(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url).slice(0, 60);
  }
}

/**
 * The persistent record of unexpected gates.
 *
 * Expected ones — Chuffed's payment page — are not written: this file exists to
 * be read when something changes, and a line per run for a challenge we already
 * design around would bury that.
 */
export class GateLog {
  /**
   * @param {string} file
   * @param {object} [options]
   * @param {boolean} [options.readOnly] dry runs keep entries in memory
   */
  constructor(file, { readOnly = false } = {}) {
    this.file = file;
    this.readOnly = readOnly;
    this.pending = [];
  }

  /** All entries, oldest first. A truncated final line is skipped. */
  all() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [...this.pending];
    }

    const entries = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        /* a killed run's half-written line */
      }
    }
    return entries.concat(this.pending);
  }

  since(when) {
    const cutoff = when instanceof Date ? when.getTime() : new Date(when).getTime();
    return this.all().filter((entry) => {
      const at = Date.parse(entry.at);
      return Number.isFinite(at) && at >= cutoff;
    });
  }

  /**
   * Record a gate.
   *
   * @param {object} entry
   * @param {string} entry.stage    plan | donate | check
   * @param {string} entry.url      where it appeared
   * @param {string} entry.kind     from detectGate
   * @param {string} entry.marker   what gave it away
   * @param {string} [entry.fqn]
   * @param {string} [entry.platform]
   * @param {string} [entry.note]
   * @returns {object} the stored record
   */
  record(entry) {
    const record = {
      at: new Date().toISOString(),
      stage: entry.stage,
      fqn: entry.fqn ?? null,
      platform: entry.platform ?? null,
      url: entry.url,
      kind: entry.kind,
      marker: entry.marker,
      ...(entry.note ? { note: entry.note } : {}),
    };

    if (this.readOnly) {
      this.pending.push(record);
      return record;
    }

    ensureDir(path.dirname(this.file));
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    return record;
  }

  clear() {
    this.pending = [];
    try {
      fs.rmSync(this.file);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Group gates for reading: one row per place-and-kind, with how often and how
 * recently it has been seen.
 */
export function summariseGates(entries) {
  const groups = new Map();

  for (const entry of entries) {
    const key = `${entry.kind} ${entry.platform ?? ''} ${entry.stage}`;
    const group = groups.get(key) ?? {
      kind: entry.kind,
      platform: entry.platform ?? null,
      stage: entry.stage,
      count: 0,
      first: entry.at,
      last: entry.at,
      examples: [],
    };
    group.count += 1;
    if (entry.at < group.first) group.first = entry.at;
    if (entry.at > group.last) group.last = entry.at;
    if (group.examples.length < 3 && !group.examples.includes(entry.url)) {
      group.examples.push(entry.url);
    }
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}
