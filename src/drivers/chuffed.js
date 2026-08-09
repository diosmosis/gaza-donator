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
import { clickFirst, findFirst, pageText, readText, readValue, typeInto } from '../browser.js';
import { parseMoney as parseMoneyWithCurrency } from '../money.js';
import { detectGateOnPage } from '../gates.js';
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
  /**
   * Chuffed adds an optional contribution to itself, pre-filled with a nonzero
   * amount. These selectors are written from the page's conventions rather than
   * observed, because the payment page only renders past a Cloudflare Turnstile
   * challenge — if the tip lands on the "fill in yourself" list, this is the
   * first thing to correct.
   */
  tipInput: [
    'input[name*="tip" i]',
    'input[name*="contribution" i]',
    'input[id*="tip" i][type="text"]',
    'input[id*="tip" i][type="number"]',
  ],
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
  return parseMoneyWithCurrency(text)?.amount ?? null;
}

/**
 * Chuffed renders every currency with a bare "$" — a campaign in AUD and one
 * in USD look identical on the page — so the symbol says nothing and the
 * campaign's real currency has to come from `readCurrency`.
 */
export function parseChuffedMoney(text) {
  return parseMoneyWithCurrency(text);
}

/**
 * The campaign's currency, taken from the GraphQL traffic the page makes to
 * render itself.
 *
 * There is no currency anywhere in the rendered page: `$942` on one campaign is
 * AUD and `$3,640` on another is USD. The only statement of it that reaches the
 * browser is the API response behind the page, so `inspect` listens for it.
 *
 * @param {string[]} bodies GraphQL response bodies seen while loading
 * @returns {string|null}
 */
export function currencyFromGraphql(bodies) {
  const counts = new Map();
  for (const body of bodies) {
    for (const [, code] of String(body).matchAll(/"currency":"([A-Z]{3})"/g)) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  // Donations in other currencies can appear alongside; the campaign's own is
  // the one the page repeats.
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const driver = {
  id: 'chuffed',
  label: 'Chuffed',

  /**
   * What `check --deep` looks for on the payment page.
   *
   * `gated`: this page sits behind a Cloudflare Turnstile challenge that does
   * not clear in a headless browser, so finding nothing proves nothing. The
   * check reports that as inconclusive rather than as a broken selector.
   */
  form: {
    gated: true,
    url: (campaignUrl, inspection) => inspection?.payUrl ?? null,
    fields: {
      amount: SELECTORS.amountInput,
      name: SELECTORS.nameInput,
      email: SELECTORS.emailInput,
      tip: SELECTORS.tipInput,
      submit: SELECTORS.submitButton,
    },
  },

  /**
   * Verification pass: is the campaign live, and what does its own page say it
   * has raised?
   *
   * @returns {Promise<{ok: boolean, note?: string, raisedTotal?: number|null, payUrl?: string|null}>}
   */
  async inspect(page, campaignUrl) {
    // Attached before navigating: the campaign's currency is only ever stated
    // in the GraphQL traffic behind the page.
    const graphql = [];
    const onResponse = async (response) => {
      if (!/\/api\/graphql/.test(response.url())) return;
      const body = await response.text().catch(() => '');
      if (body) graphql.push(body);
    };
    page.on('response', onResponse);

    try {
      const response = await page.goto(campaignUrl, { waitUntil: 'domcontentloaded' });
      const status = response?.status() ?? 0;

      await page.waitForNetworkIdle({ idleTime: 800, timeout: 20_000 }).catch(() => {});

      // Before anything is read: a challenge page has no donate button and no
      // raised total either, and blaming that on the campaign or on our
      // selectors would be wrong in both directions.
      const gate = await detectGateOnPage(page, { status });
      if (gate) return { ok: false, gate, note: `bot gate on the campaign page (${gate.kind})` };

      if (status >= 400) return { ok: false, note: `campaign page returned HTTP ${status}` };

      const text = await pageText(page);
      const closed = CLOSED_MARKERS.find((marker) => text.includes(marker));
      if (closed) return { ok: false, note: `campaign appears closed ("${closed}")` };

      const payUrl = await readDonateHref(page);
      if (!payUrl) return { ok: false, note: 'no donate button on the campaign page' };

      const raised = await readRaised(page);
      return {
        ok: true,
        raisedTotal: raised?.amount ?? null,
        raisedCurrency: currencyFromGraphql(graphql) ?? raised?.currency ?? null,
        payUrl,
      };
    } finally {
      page.off('response', onResponse);
    }
  },

  /**
   * Get to the payment page with everything we can fill filled in.
   *
   * @returns {Promise<{filled: string[], manual: string[], url: string}>}
   */
  async prepare(page, { campaignUrl, amount, tip = 0, card, donor, log = () => {} }) {
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
      // A gate here is the expected one, and the assisted flow exists for it;
      // it is reported so the caller can tell it apart from a broken page, but
      // not as something to investigate.
      const gate = await detectGateOnPage(page);
      return {
        filled: [],
        manual: ['the whole form (it never rendered)'],
        url: page.url(),
        gate,
        gateExpected: true,
      };
    }
    await form.dispose();

    const filled = [];
    const manual = [];
    const track = (label, ok) => (ok ? filled : manual).push(label);

    track('amount', await typeInto(page, SELECTORS.amountInput, String(amount), { timeoutMs: 15_000 }));
    track(tipLabel(tip), await setTip(page, tip));
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

/** What the tip step is called in the "filled" / "fill in yourself" lists. */
export function tipLabel(tip) {
  return Number(tip) > 0 ? `Chuffed tip set to ${Number(tip)}` : 'Chuffed tip zeroed';
}

/**
 * Set Chuffed's contribution to itself to `tip` (0 by default).
 *
 * Only a free-text field is touched. If Chuffed is offering preset percentages
 * in a dropdown or radio group, this reports failure so the user sets it
 * themselves — guessing at a preset control risks charging an amount nobody
 * asked for.
 */
async function setTip(page, tip) {
  const amount = Number(tip) || 0;

  const handle = await findFirst(page, SELECTORS.tipInput, { timeoutMs: 6000 });
  if (!handle) return false;
  let editable = false;
  try {
    editable = await handle.evaluate(
      (el) => el.tagName === 'INPUT' && ['text', 'number', 'tel', ''].includes(el.type),
    );
  } catch {
    return false;
  } finally {
    await handle.dispose();
  }
  if (!editable) return false;

  if (!(await typeInto(page, SELECTORS.tipInput, String(amount), { timeoutMs: 5000 }))) return false;
  return parseMoney(await readValue(page, SELECTORS.tipInput)) === amount;
}

async function readDonateHref(page) {
  // Only the href is read, and the button may be scrolled out of view.
  //
  // The wait is long because the consequence of giving up early is dropping a
  // real person: the button is rendered by the page's own JavaScript, usually
  // within 4 seconds but much later when the site is under load, and "no
  // donate button" reads as a closed campaign. Waiting costs nothing when the
  // button is there — the poll returns as soon as it appears.
  const handle = await findFirst(page, SELECTORS.donateButton, {
    timeoutMs: 25_000,
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

/**
 * The raised figure sits in a counter that animates upwards from zero, so a
 * single read returns whatever it happened to be passing through — $2,297 on a
 * campaign that has raised $3,640. Read it until it stops moving.
 *
 * (It also measures zero until the animation runs, hence `visible: false`.)
 */
async function readRaised(page, { timeoutMs = 12_000, stableMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;

  do {
    const current = parseChuffedMoney(
      await readText(page, SELECTORS.raised, { timeoutMs: 4000 }),
    );
    if (current && previous && current.amount === previous.amount) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, stableMs));
  } while (Date.now() < deadline);

  // Still moving when time ran out: the largest seen is the closest to final.
  return previous;
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
