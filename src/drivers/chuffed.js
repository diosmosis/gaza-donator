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
import {
  clickFirst,
  clickMatching,
  findFirst,
  waitForHuman,
  pageText,
  readText,
  readValue,
  settle,
  typeInto,
} from '../browser.js';
import { formatDuration } from '../progress.js';
import { parseMoney as parseMoneyWithCurrency } from '../money.js';
import { detectGateOnPage, gateIfBlocking, waitPastGate } from '../gates.js';
import { fillStripeCard } from './stripe.js';

/**
 * Selectors for the payment page, read out of Chuffed's own `payment.js`
 * bundle rather than guessed at — that page cannot be opened without clearing
 * a Cloudflare challenge first, so the shipped markup is the only reliable
 * source for it. The `data-test` and `name` attributes below are the ones the
 * bundle sets.
 */
export const SELECTORS = {
  donateButton: [
    'a.campaign-container__donate-button',
    'a[class*="donate-button"]',
    'a[href*="/pay/campaign/"]',
  ],
  raised: ['.progress-meter__value-raised', '[class*="value-raised"]'],
  target: ['.progress-meter__value-target', '[class*="value-target"]'],
  /** The "Other amount" box beside the preset impact levels. */
  amountInput: [
    'input#impact-selector-option-other',
    'input#donation-selector-option-other',
    'input[data-test="impact-selector-option-other"]',
    'input[placeholder*="amount" i]',
    'input[name="amount"]',
    'input[name*="amount" i]',
  ],
  firstNameInput: ['input[name="firstName"]', '#input-group-firstname input'],
  lastNameInput: ['input[name="lastName"]', '#input-group-lastname input'],
  emailInput: ['input[name="email"]', '#input-group-email input', 'input[type="email"]'],
  /**
   * Opens the "Change Currency" modal. The live page renders the
   * `donation-selector` variant; the `currency-selector` ids are the same
   * component under its other name, and the totals row carries a "Change
   * currency" link that opens the same modal.
   */
  currencyButton: [
    'button#donation-selector-currency-button',
    '[data-testid="donation-selector__currency-button"]',
    'button#currency-selector-currency-button',
    '[data-testid="currency-selector__currency-button"]',
    'a[data-testid="donation-change-currency"]',
  ],
  /** Where the currently selected currency is written, for reading it back. */
  currencyIndicator: [
    'button#donation-selector-currency-button',
    '[data-testid="donation-selector__currency-button"]',
    '[data-testid="currency-indicator"]',
  ],
  /** Inside that modal: the list of currencies, then Save. */
  currencySelect: [
    'select[name="currency-selector"]',
    'select.currency-selector__select',
    'select[name*="currency" i]',
  ],
  /**
   * Chuffed's button component overwrites whatever `data-test` it is given with
   * its own `link-button`, so the Save button cannot be found by the name the
   * source gives it. Hence the fallback to its label.
   */
  currencySave: ['[data-test="currency-conversion-save"]'],
  /**
   * "Keep me up to date about this campaign" and Chuffed's own marketing
   * opt-in. Both are off unless the donor turns them on themselves.
   */
  campaignUpdates: [
    'input[name="isOptIn"]',
    '[data-test="campaign-info-opt-in"] input[type="checkbox"]',
  ],
  chuffedUpdates: [
    'input[name="isOptInChuffed"]',
    '[data-test="gdpr-opt-in"] input[type="checkbox"]',
  ],
  /** Inverted: checked means the donor's name is shown on the campaign. */
  showName: ['input[name="isShowName"]'],
  submitButton: ['#js-donate-action-stripe', 'button[type="submit"]', 'button[class*="donate" i]'],
  /**
   * Chuffed's optional contribution to itself, which it pre-selects once an
   * amount is entered — $4.00 on a $10 donation, in the captured page. The
   * dropdown offers a few tiers plus "Other"; choosing "Other" reveals a free
   * input, and that input is the only way to reach any exact figure, zero
   * included. The chosen amount lands in a hidden field, which is what is
   * actually charged and so what gets checked.
   *
   * None of this exists until the donation amount is filled in, so the tip has
   * to be set after the amount.
   */
  tipSelect: ['select#donation-form-optional-tier', 'select.optional-selector__select'],
  tipCustomInput: [
    '[data-testid="optional-donation-custom-input"]',
    '.optional-selector__input-other input',
    'input[placeholder="Enter Amount"]',
  ],
  tipCharged: ['input[type="hidden"][name="chuffedAmount"]'],
};

/**
 * Chuffed sometimes serves the payment page as an "Unauthorised" notice instead
 * — a full page saying the visitor must be logged in. It is not a bot gate and
 * not a dead campaign; it is a wall that a person can walk through, so the run
 * waits for them to log in rather than giving up on the recipient.
 */
const LOGIN_MARKERS = ['unauthorised', 'unauthorized', 'must be logged in'];

/** Is this the login wall rather than the payment page? */
export function looksUnauthorised(text) {
  const haystack = String(text ?? '').toLowerCase();
  return (
    haystack.includes('must be logged in') ||
    (LOGIN_MARKERS.some((marker) => haystack.includes(marker)) && haystack.includes('permission'))
  );
}

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

      if (status >= 400) {
        const gate = await detectGateOnPage(page, { status });
        return gate
          ? { ok: false, gate, note: `bot gate on the campaign page (${gate.kind})` }
          : { ok: false, note: `campaign page returned HTTP ${status}` };
      }

      const text = await pageText(page);
      const closed = CLOSED_MARKERS.find((marker) => text.includes(marker));
      if (closed) return { ok: false, note: `campaign appears closed ("${closed}")` };

      // A challenge is only worth reporting when it is why we cannot read the
      // page — this page carries challenge widgets that have already passed.
      const payUrl = await readDonateHref(page);
      if (!payUrl) {
        const gate = await detectGateOnPage(page, { status });
        return gate
          ? { ok: false, gate, note: `bot gate on the campaign page (${gate.kind})` }
          : { ok: false, note: 'no donate button on the campaign page' };
      }

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
  async prepare(
    page,
    {
      campaignUrl,
      amount,
      tip = 0,
      currency = 'USD',
      card,
      donor,
      log = () => {},
      timeoutMs = 300_000,
      confirmGate = null,
    },
  ) {
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
    // Barely a pause at all: a challenge page never goes idle — it polls — so
    // this cap is spent in full every time, and the wait that actually matters
    // is the one below, which watches for the form itself and returns the
    // moment it appears. Ten seconds here was ten seconds of a blank window.
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 2500 }).catch(() => {});

    // A login wall looks like neither a challenge nor a closed campaign, and
    // the person can clear it — so say so and wait, the same way.
    if (looksUnauthorised(await pageText(page))) {
      log(
        '  Chuffed says this page needs a login — sign in in the browser window and the form ' +
          'will be filled in as soon as it appears',
      );
      const afterLogin = await waitForHuman(page, SELECTORS.amountInput, {
        timeoutMs,
        log,
        what: 'the Chuffed payment form (after logging in)',
      });
      if (!afterLogin) {
        return {
          filled: [],
          manual: ['the whole form (Chuffed wanted a login)'],
          url: page.url(),
          needsLogin: true,
        };
      }
      await afterLogin.dispose();
    }

    // Chuffed puts this page behind a Cloudflare Turnstile challenge and the
    // form does not exist in the DOM until that clears — so say so *before*
    // waiting, not after giving up, and then wait as long as the run allows the
    // person. The form appears the instant the challenge clears; something has
    // to be watching at that moment or the whole step is wasted.
    //
    // But only when the challenge is genuinely in the way: a browser carrying
    // Cloudflare clearance renders the form with the Turnstile widget still
    // sitting in the DOM, and announcing a challenge then sends the person
    // looking for something that is not there.
    //
    // A gate here is the expected one, and the assisted flow exists for it, so
    // it is reported but never logged as something to investigate.
    const gate = await gateIfBlocking(page, SELECTORS.amountInput, { timeoutMs: 5000 });
    if (gate) {
      log(
        `  Chuffed is showing a ${gate.kind} challenge — clear it in the browser window and ` +
          'the form will be filled in as soon as it appears',
      );
    }

    const form = await waitPastGate(page, SELECTORS.amountInput, {
      gate,
      confirmGate,
      timeoutMs,
      log,
      what: 'the Chuffed payment form',
    });
    if (!form) {
      log('  the Chuffed payment form never appeared — fill it in yourself, or run this one again');
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

    // Chuffed campaigns run in a currency the campaign owner chose, and the pay
    // page may or may not offer to change it. Only speak up when there is a
    // control showing something other than what was configured: saying
    // "currency" on every donation to a campaign that has no such control would
    // be noise, and switching one that is not there is not possible.
    const currencyResult = await setCurrency(page, currency);
    if (currencyResult) track(currencyResult.label, currencyResult.ok);

    track('amount', await typeInto(page, SELECTORS.amountInput, String(amount), { timeoutMs: 15_000 }));
    track(tipLabel(tip), await setTip(page, tip));

    const { firstName, lastName } = splitName(donor?.name ?? card.name);
    if (firstName) {
      track('first name', await typeInto(page, SELECTORS.firstNameInput, firstName, { timeoutMs: 4000 }));
      track('last name', await typeInto(page, SELECTORS.lastNameInput, lastName, { timeoutMs: 4000 }));
    }
    if (donor?.email) track('email', await typeInto(page, SELECTORS.emailInput, donor.email, { timeoutMs: 4000 }));

    // Mailing lists are opt-in, and this tool is not the one doing the opting:
    // both stay off unless the donor turns them on in the browser themselves.
    for (const [label, selectors] of [
      ['campaign updates off', SELECTORS.campaignUpdates],
      ['Chuffed updates off', SELECTORS.chuffedUpdates],
    ]) {
      const result = await setToggle(page, selectors, false);
      if (result !== null) track(label, result);
    }

    // Chuffed asks whether to show the donor's name rather than whether to hide
    // it, so anonymity means turning this one off.
    if (donor?.anonymous !== undefined) {
      const shown = await setToggle(page, SELECTORS.showName, !donor.anonymous);
      if (shown !== null) track(donor.anonymous ? 'anonymous' : 'name shown', shown);
    }

    const stripe = await fillStripeCard(page, { ...card, postalCode: donor?.postalCode });
    for (const field of stripe.filled) track(`card ${field}`, true);
    for (const field of stripe.missing) track(`card ${field}`, false);

    return { filled, manual, url: page.url() };
  },

  /**
   * Resolve once Chuffed confirms the donation. The user does the final click,
   * so this waits as long as the configured donation timeout.
   */
  async waitForConfirmation(page, { timeoutMs, log = () => {} }) {
    return waitForThanks(page, {
      timeoutMs,
      log,
      urlPattern: /\/(thank|thanks|success|confirmation|receipt)/i,
      textMarkers: ['thank you', 'thanks for your donation', 'donation successful', 'payment successful'],
    });
  },
};

/**
 * Put the payment page in `currency`, if it offers a way to.
 *
 * Chuffed's flow, read off the live page: a button showing the current code
 * ("You're donating in aud") opens a "Change Currency" modal holding a
 * `select`, and the choice only takes effect once Save is pressed.
 *
 * Returns null when the page has no currency control at all — reporting
 * "currency" on every donation to a campaign that offers no choice would be
 * noise, and a control that does not exist cannot be got wrong.
 *
 * @returns {Promise<{ok: boolean, label: string}|null>}
 */
export async function setCurrency(page, currency) {
  const want = String(currency ?? '').toUpperCase();
  if (!want) return null;

  const shown = (await readText(page, SELECTORS.currencyIndicator, { timeoutMs: 5000 }))?.trim();
  if (!shown) return null;
  // The button renders the code in lower case; the chips render it upper.
  if (shown.toUpperCase().includes(want)) return { ok: true, label: `currency (already ${want})` };

  if (!(await clickFirst(page, SELECTORS.currencyButton, { timeoutMs: 5000 }))) {
    return { ok: false, label: `currency: shows ${shown}, could not open the currency list` };
  }
  await settle(900);

  if (!(await selectOption(page, SELECTORS.currencySelect, want))) {
    return { ok: false, label: `currency: shows ${shown}, ${want} is not on offer` };
  }

  // Chuffed applies the choice on Save; without this the modal closes having
  // changed nothing.
  if (!(await saveCurrency(page))) {
    return { ok: false, label: `currency: chose ${want} but could not save it` };
  }
  await settle(1500);

  const after = (await readText(page, SELECTORS.currencyIndicator, { timeoutMs: 5000 }))?.trim();
  return after?.toUpperCase().includes(want)
    ? { ok: true, label: `currency ${shown} -> ${want}` }
    : { ok: false, label: `currency: tried ${want}, page still shows ${after ?? '?'}` };
}

/**
 * Press Save in the currency modal.
 *
 * By its label as well as by its test id: Chuffed's button component replaces
 * the `data-test` it is handed with its own, so the name the source gives this
 * button never reaches the page.
 */
async function saveCurrency(page) {
  if (await clickFirst(page, SELECTORS.currencySave, { timeoutMs: 2500 })) return true;
  return clickMatching(page, ['button', '[role="button"]'], /^\s*save\s*$/i, { timeoutMs: 4000 });
}

/**
 * Choose an option by its value or its label.
 *
 * These are React-controlled selects, which keep their own record of the
 * current value and ignore an event whose value looks unchanged. Going through
 * the prototype's setter is what makes React notice.
 */
async function selectOption(page, selectors, want) {
  const handle = await findFirst(page, selectors, { timeoutMs: 4000, visible: false });
  if (!handle) return false;
  try {
    return await handle.evaluate((el, code) => {
      const option = [...el.options].find(
        (candidate) =>
          candidate.value.toUpperCase().includes(code) ||
          candidate.textContent.toUpperCase().includes(code),
      );
      if (!option) return false;

      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(el, option.value);
      else el.value = option.value;

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, want);
  } catch {
    return false;
  } finally {
    await handle.dispose();
  }
}

/**
 * Set a toggle to a known state.
 *
 * These are checkboxes styled as switches, so the input itself is often not
 * clickable. Clicking it from inside the page fires the event React is
 * listening for, which dragging at the label does not reliably do.
 *
 * @returns {Promise<boolean|null>} null when the toggle is not on the page
 */
export async function setToggle(page, selectors, desired) {
  const handle = await findFirst(page, selectors, { timeoutMs: 3000, visible: false });
  if (!handle) return null;
  try {
    return await handle.evaluate((el, want) => {
      if (el.checked === want) return true;
      el.click();
      return el.checked === want;
    }, desired);
  } catch {
    return false;
  } finally {
    await handle.dispose();
  }
}

/** Chuffed asks for first and last name separately. */
export function splitName(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** What the tip step is called in the "filled" / "fill in yourself" lists. */
export function tipLabel(tip) {
  return Number(tip) > 0 ? `Chuffed tip set to ${Number(tip)}` : 'Chuffed tip zeroed';
}

/**
 * Set Chuffed's contribution to itself to `tip` (0 by default).
 *
 * Always through "Other": the offered tiers are a percentage of the donation
 * and never include nothing at all, so picking one could only ever approximate
 * what was asked for — and the default is not small. A $10 donation arrives
 * with $4.00 already added.
 *
 * The hidden `chuffedAmount` field is what gets charged, so that is what is
 * read back rather than the box we typed in.
 *
 * @returns {Promise<boolean>} false if the tip could not be set, so the caller
 *   can put it on the "fill in yourself" list instead of assuming
 */
export async function setTip(page, tip) {
  const want = Math.max(0, Number(tip) || 0);

  // Absent until an amount has been entered; nothing to do on a form that is
  // not offering a tip.
  const control = await findFirst(page, SELECTORS.tipSelect, { timeoutMs: 6000, visible: false });
  if (!control) return false;
  await control.dispose();

  if (!(await selectOption(page, SELECTORS.tipSelect, 'OTHER'))) return false;
  await settle(600);

  if (!(await typeInto(page, SELECTORS.tipCustomInput, String(want), { timeoutMs: 5000 }))) {
    return false;
  }
  await settle(400);

  const charged = parseMoney(await readValue(page, SELECTORS.tipCharged));
  return charged === want;
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
export async function waitForThanks(
  page,
  { timeoutMs, urlPattern, textMarkers, log = () => {}, nagMs = 30_000 },
) {
  const deadline = Date.now() + timeoutMs;
  let nextNag = Date.now() + nagMs;

  do {
    // Someone closing the tab is a decision, not a fault, and the caller has to
    // be able to tell that apart from a page that never confirmed.
    if (page.isClosed()) return { ok: false, closed: true, note: 'the tab was closed' };

    if (urlPattern.test(page.url())) return { ok: true, note: `confirmed at ${page.url()}` };

    const text = await pageText(page).catch(() => '');
    const marker = textMarkers.find((candidate) => text.includes(candidate));
    if (marker) return { ok: true, note: `confirmed ("${marker}")` };

    // The same countdown the gated path prints. A long silent wait reads as a
    // hung run, whichever platform it is on — GoFundMe had no such wait at all.
    if (Date.now() >= nextNag) {
      log(`  still waiting for the confirmation page — ${formatDuration(deadline - Date.now())} left`);
      nextNag = Date.now() + nagMs;
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(1500, Math.max(50, nagMs / 3))));
  } while (Date.now() < deadline);

  return { ok: false, note: 'timed out waiting for the confirmation page' };
}

export default driver;
