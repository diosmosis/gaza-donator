/**
 * Chuffed driver.
 *
 * Campaign pages live at chuffed.org/project/<slug> and hand off to a Stripe
 * payment page at chuffed.org/pay/campaign/<uuid>, reached through the "Donate
 * now" button. That payment page is behind a Cloudflare Turnstile challenge,
 * which is exactly why the donation step runs in a visible browser: the user
 * clears the challenge, we fill everything else.
 *
 * Selectors observed on the live site (2026-08). They are the first thing to
 * check if a run stops filling fields; see README.
 */
import { clickFirst, findFirst, pageText, readText, typeInto } from '../browser.js';
import { fillStripeCard } from './stripe.js';

export const SELECTORS = {
  donateButton: [
    'a.campaign-container__donate-button',
    'a[class*="donate-button"]',
    'a[href*="/pay/campaign/"]',
  ],
  raised: ['.progress-meter__value-raised', '[class*="value-raised"]'],
  target: ['.progress-meter__value-target', '[class*="value-target"]'],
  amountInput: [
    'input[name="amount"]',
    'input#amount',
    'input[name*="amount" i]',
    'input[id*="amount" i]',
    'input[aria-label*="amount" i]',
    'input[placeholder*="amount" i]',
  ],
  nameInput: [
    'input[name="name"]',
    'input[name*="first" i]',
    'input[id*="name" i]:not([id*="card" i])',
    'input[autocomplete="name"]',
  ],
  emailInput: ['input[type="email"]', 'input[name*="email" i]', 'input[autocomplete="email"]'],
  anonymousCheckbox: [
    'input[type="checkbox"][name*="anon" i]',
    'input[type="checkbox"][id*="anon" i]',
  ],
  submitButton: ['button[type="submit"]', 'button[class*="donate" i]'],
  /** Chuffed adds an optional contribution to itself; leave it at the user's choice but find it. */
  tipInput: ['input[name*="tip" i]', 'input[name*="contribution" i]', 'select[name*="tip" i]'],
};

const CLOSED_MARKERS = [
  'campaign has ended',
  'campaign is closed',
  'no longer accepting',
  'page not found',
  "doesn't exist",
  'does not exist',
];

/** "$3,439" -> 3439 */
export function parseMoney(text) {
  if (!text) return null;
  const match = String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

const driver = {
  id: 'chuffed',
  label: 'Chuffed',

  /**
   * Verification pass: is the campaign live, and what does its own page say it
   * has raised?
   *
   * @returns {Promise<{ok: boolean, note?: string, raisedTotal?: number|null, payUrl?: string|null}>}
   */
  async inspect(page, campaignUrl) {
    const response = await page.goto(campaignUrl, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    if (status >= 400) return { ok: false, note: `campaign page returned HTTP ${status}` };

    await page.waitForNetworkIdle({ idleTime: 800, timeout: 20_000 }).catch(() => {});

    const text = await pageText(page);
    const closed = CLOSED_MARKERS.find((marker) => text.includes(marker));
    if (closed) return { ok: false, note: `campaign appears closed ("${closed}")` };

    const payUrl = await readDonateHref(page);
    if (!payUrl) return { ok: false, note: 'no donate button on the campaign page' };

    return { ok: true, raisedTotal: await readRaised(page), payUrl };
  },

  /**
   * Get to the payment page with everything we can fill filled in.
   *
   * @returns {Promise<{filled: string[], manual: string[], url: string}>}
   */
  async prepare(page, { campaignUrl, amount, card, donor, log = () => {} }) {
    if (!page.url().startsWith(campaignUrl)) {
      await page.goto(campaignUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 20_000 }).catch(() => {});
    }

    const payUrl = await readDonateHref(page);
    if (payUrl) {
      await page.goto(payUrl, { waitUntil: 'domcontentloaded' });
    } else if (!(await clickFirst(page, SELECTORS.donateButton, { timeoutMs: 10_000 }))) {
      throw new Error('could not find the Donate button');
    }
    await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30_000 }).catch(() => {});

    // Chuffed puts its payment page behind a Cloudflare Turnstile challenge, and
    // the form does not exist in the DOM until that clears. Wait for it rather
    // than reporting every field as unfillable.
    const form = await findFirst(page, SELECTORS.amountInput, {
      timeoutMs: 90_000,
      visible: false,
    });
    if (!form) {
      log('  the Chuffed payment form has not appeared — clear the Cloudflare check in the browser');
      return { filled: [], manual: ['the whole form (it never rendered)'], url: page.url() };
    }
    await form.dispose();

    const filled = [];
    const manual = [];
    const track = (label, ok) => (ok ? filled : manual).push(label);

    track('amount', await typeInto(page, SELECTORS.amountInput, String(amount), { timeoutMs: 15_000 }));
    if (donor?.name) track('name', await typeInto(page, SELECTORS.nameInput, donor.name, { timeoutMs: 4000 }));
    if (donor?.email) track('email', await typeInto(page, SELECTORS.emailInput, donor.email, { timeoutMs: 4000 }));

    const stripe = await fillStripeCard(page, { ...card, postalCode: donor?.postalCode });
    for (const field of stripe.filled) track(`card ${field}`, true);
    for (const field of stripe.missing) track(`card ${field}`, false);

    return { filled, manual, url: page.url() };
  },

  /**
   * Resolve once Chuffed confirms the donation. The user does the final click,
   * so this waits as long as the configured donation timeout.
   */
  async waitForConfirmation(page, { timeoutMs }) {
    return waitForThanks(page, {
      timeoutMs,
      urlPattern: /\/(thank|thanks|success|confirmation|receipt)/i,
      textMarkers: ['thank you', 'thanks for your donation', 'donation successful', 'payment successful'],
    });
  },
};

async function readDonateHref(page) {
  // Only the href is read, and the button may be scrolled out of view.
  const handle = await findFirst(page, SELECTORS.donateButton, {
    timeoutMs: 10_000,
    visible: false,
  });
  if (!handle) return null;
  try {
    const href = await handle.evaluate((el) => el.getAttribute('href'));
    return href ? new URL(href, page.url()).toString() : null;
  } finally {
    await handle.dispose();
  }
}

async function readRaised(page) {
  // The raised figure sits in an animated counter that measures zero until the
  // animation runs, so read it without a visibility check.
  return parseMoney(await readText(page, SELECTORS.raised, { timeoutMs: 8000 }));
}

/**
 * Poll for a confirmation URL or a thank-you message.
 * Shared shape between drivers; kept here to avoid a module both import for
 * three lines.
 */
export async function waitForThanks(page, { timeoutMs, urlPattern, textMarkers }) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (page.isClosed()) return { ok: false, note: 'browser window closed before confirmation' };

    if (urlPattern.test(page.url())) return { ok: true, note: `confirmed at ${page.url()}` };

    const text = await pageText(page).catch(() => '');
    const marker = textMarkers.find((candidate) => text.includes(candidate));
    if (marker) return { ok: true, note: `confirmed ("${marker}")` };

    await new Promise((resolve) => setTimeout(resolve, 1500));
  } while (Date.now() < deadline);

  return { ok: false, note: 'timed out waiting for the confirmation page' };
}

export default driver;
