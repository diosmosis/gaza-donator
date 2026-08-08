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
import { ensureDir } from './paths.js';

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
   */
  constructor({ headless = true, userDataDir = null, timeoutMs = 45_000 } = {}) {
    this.headless = headless;
    this.userDataDir = userDataDir;
    this.timeoutMs = timeoutMs;
    this.browser = null;
  }

  async launch() {
    if (this.browser) return this.browser;

    const puppeteer = await loadPuppeteer();
    if (this.userDataDir) ensureDir(this.userDataDir);

    this.browser = await puppeteer.launch({
      headless: this.headless,
      userDataDir: this.userDataDir ?? undefined,
      defaultViewport: this.headless ? { width: 1280, height: 900 } : null,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        ...(this.headless ? [] : ['--window-size=1280,960']),
      ],
    });
    return this.browser;
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
    if (!this.browser) return;
    const browser = this.browser;
    this.browser = null;
    await browser.close().catch(() => {});
  }
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
export async function findFirst(frame, selectors, { timeoutMs = 8000, visible = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
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
