/**
 * Puppeteer lifecycle helpers.
 *
 * Two modes:
 *   - headless, for the verification scrapes (campaign alive, raised total)
 *   - headful with a persistent profile, for the assisted donation flow, so
 *     cookie banners and any Cloudflare clearance survive between runs and the
 *     user is not re-challenged on every donation.
 *
 * puppeteer is imported lazily: `plan --no-verify`, `card`, `history` and the
 * whole test suite never need a browser binary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.js';
import { formatDuration } from './progress.js';

let puppeteerPromise = null;

async function loadPuppeteer() {
  if (!puppeteerPromise) {
    puppeteerPromise = import('puppeteer').then((module) => module.default ?? module);
  }
  try {
    return await puppeteerPromise;
  } catch (err) {
    puppeteerPromise = null;
    throw new Error(
      `puppeteer is not available (${err.message}).\n` +
        'Run `npm install`, or pass --no-verify to skip the browser steps.',
    );
  }
}

export class BrowserSession {
  /**
   * @param {object} [options]
   * @param {boolean} [options.headless]
   * @param {string} [options.userDataDir] persist the profile (headful mode)
   * @param {number} [options.timeoutMs]   default navigation timeout
   * @param {(options: object) => Promise<object>} [options.launcher] stands in
   *   for puppeteer.launch; only tests pass this
   */
  constructor({ headless = true, userDataDir = null, timeoutMs = 45_000, launcher = null } = {}) {
    this.headless = headless;
    this.userDataDir = userDataDir;
    this.timeoutMs = timeoutMs;
    this.launcher = launcher;
    this.browser = null;
    this.launching = null;
  }

  /**
   * The browser, starting it if it is not running.
   *
   * The launch is memoised as a *promise*, not just as the result: several
   * pages opened at once would otherwise each find `browser` still null and
   * start their own Chrome, and the extras — never stored, never closed —
   * outlive the run.
   */
  async launch() {
    if (this.browser) return this.browser;

    this.launching ??= this.#start().catch((err) => {
      this.launching = null; // let a later call try again
      throw err;
    });
    return this.launching;
  }

  async #start() {
    const launch = this.launcher ?? (await loadPuppeteer()).launch;
    if (this.userDataDir) {
      ensureDir(this.userDataDir);
      quietenChrome(this.userDataDir);
    }

    this.browser = await launch({
      headless: this.headless,
      userDataDir: this.userDataDir ?? undefined,
      defaultViewport: this.headless ? { width: 1280, height: 900 } : null,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        // The donation profile is persistent so that Cloudflare clearance
        // survives between runs. Chrome takes that to mean it should also
        // restore the tabs from last time, which piles up a window of dead
        // payment pages.
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
        // Chrome offering to remember the card after every donation is a modal
        // between the run and the next recipient.
        '--disable-features=AutofillSaveCardBubble,AutofillEnableCvcStorage,PasswordManagerEnabled',
        ...(this.headless ? [] : ['--window-size=1280,960']),
      ],
    });

    if (this.userDataDir) await this.#closeRestoredTabs();
    return this.browser;
  }

  /**
   * Leave exactly one blank tab behind.
   *
   * The flags above ask Chrome not to restore a session; this is what makes
   * sure of it, whatever the profile was left in.
   */
  async #closeRestoredTabs() {
    const pages = await this.browser.pages().catch(() => []);
    if (pages.length === 0) return;

    const [keep, ...rest] = pages;
    for (const page of rest) await page.close().catch(() => {});
    if (keep.url() !== 'about:blank') {
      await keep.goto('about:blank').catch(() => {});
    }
  }

  /** A page with sane defaults. Caller closes it (or use `withPage`). */
  async newPage() {
    const browser = await this.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(this.timeoutMs);
    page.setDefaultNavigationTimeout(this.timeoutMs);
    return page;
  }

  /** Run `fn` with a fresh page, always closing it afterwards. */
  async withPage(fn) {
    const page = await this.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close() {
    // A launch still in flight has to be awaited, or its browser is orphaned.
    const pending = this.launching;
    this.launching = null;
    const browser = this.browser ?? (pending ? await pending.catch(() => null) : null);
    this.browser = null;
    if (!browser) return;

    const child = browser.process?.() ?? null;
    await browser.close().catch(() => {});

    // After a run with several pages open at once, Chrome sometimes outlives
    // close() — and a surviving child process keeps the CLI running after it
    // has printed everything it has to say.
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
}

/**
 * Turn off Chrome's own offers to remember things.
 *
 * "Save card?", "Save password?" and the address prompt all appear *after* a
 * donation is submitted, over the top of the next page, and each one is a
 * dialog someone has to dismiss before the run can go on. They are ordinary
 * profile settings, so they are written into the profile before Chrome starts;
 * an existing profile is merged into rather than replaced.
 */
export function quietenChrome(userDataDir) {
  const file = path.join(userDataDir, 'Default', 'Preferences');
  let prefs = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // no profile yet, or an unreadable one: start from nothing
  }

  const merged = {
    ...prefs,
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
    profile: { ...(prefs.profile ?? {}), password_manager_enabled: false },
    autofill: {
      ...(prefs.autofill ?? {}),
      credit_card_enabled: false,
      payment_methods_mandatory_reauth: false,
      profile_enabled: false,
    },
    payments: { ...(prefs.payments ?? {}), can_make_payment_enabled: false },
  };

  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(merged));
    return true;
  } catch {
    return false; // a profile we cannot write to still works, just noisily
  }
}

/**
 * Did this fail because the tab or browser went away?
 *
 * Someone closing the window is a decision, not a fault: it means the donation
 * is done, or that they would rather not go through with this one.
 */
export function isClosedError(error) {
  return /target closed|session closed|protocol error.*closed|page has been closed|browser has disconnected/i.test(
    error?.message ?? '',
  );
}

/**
 * Click/fill helpers that take an ordered list of candidate selectors.
 * Site markup changes often; every driver expresses its selectors as fallback
 * lists and these helpers try them in order.
 */

/**
 * @param {object} [options]
 * @param {boolean} [options.visible] require the element to be on screen.
 *   Interactions need this; reading text does not — animated counters and
 *   collapsed wrappers hold real text while measuring zero.
 * @returns {Promise<import('puppeteer').ElementHandle|null>}
 */
export async function findFirst(frame, selectors, options = {}) {
  return findFirstAcross([frame], selectors, options);
}

/**
 * The same, but looking in several documents at once.
 *
 * A checkout is not always one document: GoFundMe's newer one serves its card
 * fields from an iframe on another origin, and `frame.$` never crosses that
 * boundary. Every surface is polled inside a *single* deadline rather than
 * given a timeout each — searching them in turn would multiply the wait by the
 * number of frames, and all of that time would be spent on documents that
 * simply are not the one holding the field.
 *
 * Surfaces are given in priority order and detached ones are skipped: a frame
 * that re-rendered mid-search is not an error, it just has nothing to say.
 *
 * @param {Array<import('puppeteer').Frame|import('puppeteer').Page>} frames
 */
export async function findFirstAcross(frames, selectors, { timeoutMs = 8000, visible = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const frame of frames) {
      if (!frame || frame.isDetached?.()) continue;
      for (const selector of selectors) {
        const handle = await frame.$(selector).catch(() => null);
        if (handle) {
          if (!visible) return handle;
          const visibleNow = await handle
            .evaluate((el) => {
              const style = globalThis.getComputedStyle(el);
              return (
                style.visibility !== 'hidden' &&
                style.display !== 'none' &&
                el.getClientRects().length > 0
              );
            })
            .catch(() => false);
          if (visibleNow) return handle;
          await handle.dispose();
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return null;
}

/**
 * These checkout pages re-render as fields are touched, which destroys the
 * execution context an element handle belongs to. That is a transient race, not
 * a real failure, so the interaction helpers take a second run at it.
 */
const FLAKY = /execution context was destroyed|same javascript world|node is detached|target closed/i;

async function withRetry(action, attempts = 2) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (err) {
      if (attempt >= attempts || !FLAKY.test(err.message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** Type into the first matching field, clearing whatever is there. */
export async function typeInto(frame, selectors, value, { timeoutMs = 8000, delay = 45 } = {}) {
  return withRetry(async () => {
    const handle = await findFirst(frame, selectors, { timeoutMs });
    if (!handle) return false;
    try {
      await handle.click({ clickCount: 3 });
      await handle.press('Backspace').catch(() => {});
      await handle.type(String(value), { delay });
      return true;
    } finally {
      await handle.dispose();
    }
  });
}

export async function clickFirst(frame, selectors, { timeoutMs = 8000 } = {}) {
  return withRetry(async () => {
    const handle = await findFirst(frame, selectors, { timeoutMs });
    if (!handle) return false;
    try {
      await handle.click();
      return true;
    } finally {
      await handle.dispose();
    }
  });
}

/**
 * Click the first element matching one of `selectors` whose text also matches
 * `pattern`. Used where a class name alone is too blunt to be safe — the
 * "enter custom tip" control on GoFundMe shares its class with other buttons on
 * the checkout, and clicking the wrong one changes what is charged.
 */
export async function clickMatching(frame, selectors, pattern, { timeoutMs = 6000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const selector of selectors) {
      const handles = await frame.$$(selector).catch(() => []);
      for (const handle of handles) {
        const text = await handle.evaluate((el) => el.textContent ?? '').catch(() => '');
        if (pattern.test(text)) {
          try {
            await handle.click();
            return true;
          } catch {
            // fall through to the next candidate
          } finally {
            await handle.dispose();
          }
        } else {
          await handle.dispose();
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return false;
}

/**
 * Click the first control whose text matches, looking inside shadow roots too.
 *
 * Consent banners are routinely built as web components — GoFundMe's is
 * Transcend, mounted into `#transcend-consent-manager` — and everything inside
 * a shadow root is invisible to `document.querySelector`, which is what every
 * other helper here uses. So this one walks the tree itself.
 *
 * Patterns are tried in order, so the caller's preference is honoured across
 * the whole page rather than per element.
 *
 * @param {import('puppeteer').Page} page
 * @param {RegExp[]} patterns
 * @returns {Promise<string|null>} the text of what was clicked
 */
export async function clickDeepMatching(page, patterns) {
  const specs = patterns.map((pattern) => ({ source: pattern.source, flags: pattern.flags }));

  try {
    return await page.evaluate((all) => {
      const wanted = all.map(({ source, flags }) => new RegExp(source, flags));

      const controls = [];
      const roots = [document];
      const seen = new Set();
      while (roots.length > 0) {
        const root = roots.pop();
        if (!root || seen.has(root)) continue;
        seen.add(root);

        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) roots.push(el.shadowRoot);
          const isControl =
            el.tagName === 'BUTTON' ||
            el.tagName === 'A' ||
            el.getAttribute?.('role') === 'button' ||
            (el.tagName === 'INPUT' && /^(button|submit)$/i.test(el.type));
          if (isControl) controls.push(el);
        }
      }

      const label = (el) =>
        (el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();

      for (const pattern of wanted) {
        for (const el of controls) {
          const text = label(el);
          if (text && pattern.test(text)) {
            el.click();
            return text;
          }
        }
      }
      return null;
    }, specs);
  } catch {
    return null;
  }
}

/** Current value of the first matching field, or null. */
export async function readValue(frame, selectors, { timeoutMs = 4000 } = {}) {
  const handle = await findFirst(frame, selectors, { timeoutMs, visible: false });
  if (!handle) return null;
  try {
    return await handle.evaluate((el) => el.value ?? null);
  } catch {
    return null;
  } finally {
    await handle.dispose();
  }
}

/**
 * Wait for something that only appears once a person has done something —
 * cleared a Cloudflare challenge, usually.
 *
 * Unlike `findFirst`, this is measured in human time, so it says what it is
 * waiting for and keeps saying it. Giving up quietly is the one thing it must
 * not do: the form appears the moment the challenge clears, and if nothing is
 * watching by then, the run stalls with a filled-out page nobody fills.
 *
 * @param {import('puppeteer').Page} page
 * @param {string[]} selectors
 * @param {object} [options]
 * @param {number} [options.timeoutMs] how long the person has
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.what]      named in the waiting message
 * @param {number} [options.nagMs]     how often to repeat it
 * @param {Promise<unknown>} [options.ready] resolves when the person says they
 *   are done. Whoever is first wins: if the element turns up on its own, no
 *   confirmation is needed; if the person says so first, the element gets a
 *   short grace period to appear before this gives up on it.
 * @param {number} [options.graceMs] how long to keep looking after that
 * @returns {Promise<import('puppeteer').ElementHandle|null>}
 */
export async function waitForHuman(
  page,
  selectors,
  {
    timeoutMs = 300_000,
    log = () => {},
    what = 'the form',
    nagMs = 30_000,
    ready = null,
    graceMs = 15_000,
    now = Date.now,
  } = {},
) {
  let deadline = now() + timeoutMs;
  let nextNag = now() + nagMs;
  let announced = false;
  let released = false;

  if (ready) ready.then(() => (released = true)).catch(() => {});

  for (;;) {
    if (released && !announced) {
      announced = true;
      deadline = now() + graceMs;
      log(`  thanks — looking for ${what}`);
    }

    const remaining = deadline - now();
    if (remaining <= 0) return null;

    const handle = await findFirst(page, selectors, {
      timeoutMs: Math.min(3000, remaining),
      visible: false,
    });
    if (handle) return handle;

    // With a prompt on screen, the prompt is the message; repeating ourselves
    // over the top of it would only push the cursor around.
    if (!ready && now() >= nextNag) {
      log(`  still waiting for ${what} — ${formatDuration(deadline - now())} left`);
      nextNag = now() + nagMs;
    }
  }
}

/** Let a React re-render finish before touching the next field. */
export async function settle(ms = 1200) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stripe card inputs live in cross-origin iframes that attach asynchronously.
 *
 * @param {import('puppeteer').Page} page
 * @param {RegExp} urlPattern
 * @returns {Promise<import('puppeteer').Frame|null>}
 */
export async function waitForFrame(page, urlPattern, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const frame = page.frames().find((candidate) => urlPattern.test(candidate.url()));
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return null;
}

/** Text of the first matching element, whether or not it is on screen. */
export async function readText(frame, selectors, { timeoutMs = 8000 } = {}) {
  const handle = await findFirst(frame, selectors, { timeoutMs, visible: false });
  if (!handle) return null;
  try {
    return await handle.evaluate((el) => el.textContent?.trim() ?? '');
  } finally {
    await handle.dispose();
  }
}

/** Text content of the page, lowercased, for cheap state checks. */
export async function pageText(page) {
  return (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase();
}
