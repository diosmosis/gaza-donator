/**
 * GoFundMe driver.
 *
 * The checkout lives at gofundme.com/f/<slug>/donate and, unlike Chuffed, keeps
 * its card inputs in the first-party page (payments go through Adyen behind the
 * scenes), so every field can be filled directly.
 *
 * Two details matter for donating the amount the user actually asked for:
 *   - GoFundMe pre-selects a tip to itself; `setTip` forces it to the configured
 *     `tipAmount`, which defaults to 0 so the whole amount reaches the family.
 *   - The card fields only render once the "credit card" payment method is
 *     selected.
 *
 * There are currently *two* checkouts, and which one a campaign gets is decided
 * by GoFundMe, not by anything in the URL — see `paymentSurfaces`.
 *
 * Selectors observed on the live site (2026-08, second checkout 2026-09); see
 * README if they rot.
 */
import {
  clickDeepMatching,
  clickFirst,
  clickMatching,
  findFirst,
  findFirstAcross,
  pageText,
  readText,
  readValue,
  settle,
  typeInto,
} from '../browser.js';
import { parseMoney } from '../money.js';
import { detectGateOnPage, gateIfBlocking, isClearable, waitPastGate } from '../gates.js';
import { waitForThanks } from './chuffed.js';

export const SELECTORS = {
  amountInput: ['input#checkout-donation', 'input[name="donationAmount"]'],
  currencyButton: [
    'button[data-tracking-id="checkout: currency dropdown"]',
    'button[class*="currency-select_tagButton"]',
  ],
  currencyOption: ['button[data-tracking-id="checkout: currency selection"]', '[role="option"]'],
  tipSlider: ['input[type="range"][aria-label="Tip amount"]', 'input[type="range"][aria-label*="tip" i]'],
  customTipButton: ['button.hrt-text-button', 'button[class*="text-button"]'],
  customTipInput: ['input[name*="tip" i]', 'input[id*="tip" i][type="text"]'],
  /**
   * "Give once" against "Monthly". Only the payment-elements checkout has it,
   * and it decides whether the card is charged once or every month.
   */
  giveOnceTab: ['[data-tracking-id="Checkout: Choose one time donation"]'],
  cardRadio: [
    'input#add-card',
    '[data-testid="payment-method-radio-CREDIT_CARD"]',
    'input[name="paymentMethod"][value="CREDIT_CARD"]',
  ],
  cardNumber: ['input#card-number', 'input[name="card.number"]'],
  cardExpiry: ['input#card-expiration', 'input[name="card.expirationDate"]'],
  // The payment-elements markup spells this one `card.cvv`; the id is shared.
  cardCvv: ['input#card-cvv', 'input[name="card.cvv"]', 'input[name="card.CVV"]'],
  cardName: [
    'input#card-name',
    'input[name="card.name"]',
    'input[name="cardHolderName"]',
    '[data-testid="cardHolderName"]',
  ],
  email: ['input#email-address', 'input[name="email"]', '[data-testid="email"]'],
  firstName: ['input#first-name', 'input[name="firstName"]', '[data-testid="firstName"]'],
  lastName: ['input#last-name', 'input[name="lastName"]', '[data-testid="lastName"]'],
  postalCode: [
    'input#location-postal-code',
    'input[name="postalCode"]',
    '[data-testid="postalCode"]',
  ],
  anonymous: ['input#checkout-optional-anonymous', 'input[name="checkoutPersonalAnonymous"]'],
  saveCard: ['input#save-card', 'input[name="saveCard"]'],
  submitButton: [
    'button#donate-now',
    '[data-testid="card-checkout-submit-button"]',
    'button[type="submit"][aria-label*="Donate" i]',
  ],
  raised: ['[data-testid="progress-meter-heading"]', 'h2[class*="progress"]', '.progress-meter_progressMeterHeading__Nb7lL'],
  /**
   * The donate call-to-action on the *campaign* page — not the checkout's own
   * submit button. Its wording is the only thing that says whether this
   * campaign takes a one-off donation; see `takesOneOffDonations`.
   */
  campaignDonateButton: [
    'a[class*="donate-button_donateButton"]',
    'a[href*="/donate?"]',
    'a[href$="/donate"]',
  ],
  /**
   * The privacy strip GoFundMe floats over the bottom of the page. It sits on
   * top of the checkout and swallows clicks meant for the form underneath.
   */
  privacyBanner: [
    // GoFundMe's is Transcend, mounted into an otherwise empty host div whose
    // entire UI lives in a shadow root — nothing inside it can be reached with
    // an ordinary selector.
    '#transcend-consent-manager',
    '#onetrust-banner-sdk',
    '.ot-sdk-container',
    '[id*="consent" i]',
    '[class*="privacy-banner" i]',
    '[class*="consent" i][class*="banner" i]',
    '[data-testid*="privacy" i]',
    '[data-testid*="consent" i]',
  ],
};

/**
 * What to press on that strip, in order of preference.
 *
 * Sharing less is the default this tool takes on the donor's behalf, so the
 * refusals come first and "accept" is never among them: dismissing a privacy
 * prompt by consenting to everything is not dismissing it.
 */
export const PRIVACY_CHOICES = [
  /don'?t share my (?:personal )?(?:data|info(?:rmation)?)/i,
  /do not (?:sell|share) my/i,
  /do not (?:sell|share)\b/i,
  /^\s*(?:reject|decline|refuse)(?: all| everything)?\s*$/i,
  /^\s*only (?:necessary|essential|required)/i,
  /^\s*(?:necessary|essential) (?:cookies )?only\s*$/i,
  /^\s*opt[- ]?out\s*$/i,
];

/**
 * Wording GoFundMe uses for a button that starts a subscription rather than a
 * single donation.
 */
const RECURRING_ONLY = /\b(?:monthly|recurring|per month|subscribe|subscription)\b/i;

/**
 * Does this campaign take a one-off donation?
 *
 * An organiser can set a fundraiser to collect monthly subscriptions only, and
 * the page says so nowhere in words: the story, the totals and the donor list
 * all read as normal, `/donate` quietly redirects back to the campaign so the
 * checkout never appears, and the single difference is that every donate
 * button reads "Donate monthly" instead of "Donate now". Undetected, the
 * candidate is ranked and picked, and the run opens a browser onto a form that
 * does not exist.
 *
 * A campaign offering both is fine — only the ones offering nothing else are
 * dropped. Reading no labels at all says nothing (the page never rendered, or
 * the markup moved), so it is not treated as a refusal; the gate and status
 * checks are what speak to that.
 *
 * @param {string[]} labels the text of every donate call-to-action on the page
 */
export function takesOneOffDonations(labels) {
  const found = (labels ?? []).map((label) => String(label).trim()).filter(Boolean);
  if (found.length === 0) return true;
  return !found.every((label) => RECURRING_ONLY.test(label));
}

const CLOSED_MARKERS = [
  'fundraiser is no longer accepting donations',
  'no longer accepting donations',
  'this fundraiser has been',
  'campaign is not available',
  "we can't find the page",
  'page not found',
];

/** Campaign URL -> checkout URL. */
export function donateUrl(campaignUrl) {
  const url = new URL(campaignUrl);
  url.hash = '';
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/donate`;
  return url.toString();
}

/** "$12,345 raised of $50,000 goal" -> 12345 */
export function parseRaised(text) {
  return parseRaisedWithCurrency(text)?.amount ?? null;
}

/**
 * The same, keeping the currency.
 *
 * GoFundMe writes the symbol into the progress line — "€6,909 raised of
 * €20,000" — and distinguishes the dollars it supports (CA$, A$, MX$), so a
 * bare "$" means USD.
 *
 * @returns {{amount: number, currency: string|null}|null}
 */
export function parseRaisedWithCurrency(text) {
  if (!text) return null;
  const match = String(text)
    .replace(/,/g, '')
    .match(/((?:[A-Z]{0,2}\$|€|£|¥|₪|₹|R\$|kr)?\s*[\d.]+\s*[km]?)\s*(?:raised|of)/i);
  return match ? parseMoney(match[1], { defaultCurrency: 'USD' }) : null;
}

/** The amount field formats itself ("$10.00"); compare on the number. */
export function parseAmount(text) {
  if (text === null || text === undefined || text === '') return null;
  const match = String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

/** MM/YY, the format GoFundMe's expiry field expects. */
export function formatExpiry(card) {
  return `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`;
}

/** Split a donor name into the first/last fields GoFundMe asks for. */
export function splitName(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * The frames GoFundMe's newer checkout serves its payment section from. They
 * are on a different origin from the campaign page, which is the whole reason
 * they have to be named: nothing on the outer page reaches into them.
 */
const PAYMENT_ELEMENT_FRAMES = {
  fields: /payment-elements\.gofundme\.com\/v1\/checkout-payment-methods/i,
  submit: /payment-elements\.gofundme\.com\/v1\/checkout-submit-button/i,
};

/** The first live frame whose URL matches, or null. */
function frameMatching(page, pattern) {
  return page.frames().find((frame) => !frame.isDetached() && pattern.test(frame.url())) ?? null;
}

/**
 * Work out where each part of this checkout actually lives.
 *
 * GoFundMe is midway through replacing its checkout and decides per campaign
 * which one you get — there is nothing in the URL, and nothing visible on the
 * page, that says which:
 *
 *   first-party      the checkout this driver was written against. Amount,
 *                    payment methods, card fields and the donate button are all
 *                    in the campaign page itself.
 *   payment-elements the newer one. The amount, tip and anonymity controls stay
 *                    on the page, but the payment method list, every personal
 *                    and card field, and the donate button are served from
 *                    payment-elements.gofundme.com in iframes.
 *
 * `page.$` does not cross into an iframe, so on the newer checkout every card
 * field read as absent and the run quietly handed the entire form back to the
 * donor to type in themselves — no error, because "field not found" is exactly
 * what this driver expects on a checkout that has not rendered yet.
 *
 * Both layouts are returned as *surfaces* — a page or a frame, either of which
 * the browser helpers take — so the filling code does not have to know which it
 * was given.
 *
 * @returns {Promise<{layout: string, fields: object, submit: object}>}
 */
export async function paymentSurfaces(page, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const fields = frameMatching(page, PAYMENT_ELEMENT_FRAMES.fields);
    if (fields) {
      return {
        layout: 'payment-elements',
        fields,
        // The submit button has a frame of its own and is slower to arrive;
        // falling back to the page keeps this from being the thing that fails.
        submit: frameMatching(page, PAYMENT_ELEMENT_FRAMES.submit) ?? page,
      };
    }

    // No payment frame: either the old checkout, or the new one still loading.
    // Its own payment method list is what tells those apart.
    const radio = await findFirst(page, SELECTORS.cardRadio, { timeoutMs: 400, visible: false });
    if (radio) {
      await radio.dispose();
      return { layout: 'first-party', fields: page, submit: page };
    }
  } while (Date.now() < deadline);

  // Nothing recognisable. The page is still the best guess, and the caller
  // reports each field it could not fill anyway.
  return { layout: 'unknown', fields: page, submit: page };
}

/**
 * Make sure the checkout is set to donate once rather than every month.
 *
 * Only the newer checkout has the choice, and it normally opens on "Give once"
 * — but "normally" is not good enough when being wrong means signing the donor
 * up to a recurring charge, so it is read and, if need be, set.
 *
 * @returns {Promise<{present: boolean, acted: boolean, ok: boolean}>}
 */
export async function setGiveOnce(page) {
  const tab = await findFirst(page, SELECTORS.giveOnceTab, { timeoutMs: 4000, visible: false });
  if (!tab) return { present: false, acted: false, ok: true };

  const selected = (handle) =>
    handle.evaluate((el) => el.getAttribute('aria-selected') === 'true').catch(() => false);

  try {
    if (await selected(tab)) return { present: true, acted: false, ok: true };
    await tab.click();
    await settle(800);
    return { present: true, acted: true, ok: await selected(tab) };
  } catch {
    return { present: true, acted: true, ok: false };
  } finally {
    await tab.dispose();
  }
}

const driver = {
  id: 'gofundme',
  label: 'GoFundMe',

  /**
   * What `check --deep` looks for on the payment page: the controls `prepare`
   * needs before it can fill anything. The card fields are deliberately absent
   * — they only render once the card payment method is chosen.
   *
   * GoFundMe's checkout renders headless, so a missing control here is a real
   * finding rather than bot protection.
   */
  form: {
    gated: false,
    url: (campaignUrl) => donateUrl(campaignUrl),

    /**
     * Every document the controls below can be in. Without this the check only
     * ever looks at the campaign page, so every campaign on the newer checkout
     * reports its payment fields as missing — which is precisely the breakage
     * this check exists to catch, misfiled as a rotted selector.
     */
    surfaces: async (page) => {
      const { fields, submit } = await paymentSurfaces(page);
      return [...new Set([page, fields, submit])];
    },

    /**
     * Nothing but the amount exists until a payment method is chosen — on both
     * checkouts. Checking before that would report the whole form as missing.
     */
    reveal: async (page) => {
      const { fields } = await paymentSurfaces(page);
      if (!(await clickFirst(fields, SELECTORS.cardRadio, { timeoutMs: 8000 }))) return;
      await page.waitForNetworkIdle({ idleTime: 600, timeout: 15_000 }).catch(() => {});
      await settle();
    },

    fields: {
      amount: SELECTORS.amountInput,
      'tip slider': SELECTORS.tipSlider,
      'card payment option': SELECTORS.cardRadio,
      email: SELECTORS.email,
      'first name': SELECTORS.firstName,
      'last name': SELECTORS.lastName,
      'card number': SELECTORS.cardNumber,
      'card expiry': SELECTORS.cardExpiry,
      'card cvv': SELECTORS.cardCvv,
      'card name': SELECTORS.cardName,
      submit: SELECTORS.submitButton,
    },
  },

  async inspect(page, campaignUrl) {
    const response = await page.goto(campaignUrl, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;

    await page.waitForNetworkIdle({ idleTime: 800, timeout: 20_000 }).catch(() => {});

    const text = await pageText(page);
    const closed = CLOSED_MARKERS.find((marker) => text.includes(marker));
    if (closed) return { ok: false, note: `campaign appears closed ("${closed}")` };

    const raised = parseRaisedWithCurrency(text);

    // A challenge is worth reporting only when it is why the page would not
    // read — pages carry challenge widgets that never challenged anyone.
    if (status >= 400 || !raised) {
      const gate = await detectGateOnPage(page, { status });
      if (gate) return { ok: false, gate, note: `bot gate on the campaign page (${gate.kind})` };
      if (status >= 400) return { ok: false, note: `campaign page returned HTTP ${status}` };
    }

    // Only once the page is known to have rendered: an empty button list on a
    // page we never really loaded would mean nothing either way.
    const ctas = await readDonateLabels(page);
    if (!takesOneOffDonations(ctas)) {
      return { ok: false, note: `campaign only takes monthly donations ("${ctas[0]}")` };
    }

    return {
      ok: true,
      raisedTotal: raised?.amount ?? null,
      raisedCurrency: raised?.currency ?? null,
      payUrl: donateUrl(campaignUrl),
    };
  },

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
    await page.goto(donateUrl(campaignUrl), { waitUntil: 'domcontentloaded' });
    // A short settle only: the checkout is then polled for directly, so a
    // page that keeps chattering does not hold up the fill.
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 4000 }).catch(() => {});

    // GoFundMe's checkout normally renders for us. If it has put up a challenge
    // instead, wait for the person to clear it rather than walking away from a
    // form that is about to appear — but ask only when the checkout is really
    // missing, not merely because a challenge widget is on the page.
    const gate = await gateIfBlocking(page, SELECTORS.amountInput, { timeoutMs: 5000 });

    // Nothing for a person to clear — the site is declining to serve us for
    // now. Reported at once rather than waited out.
    if (gate && !isClearable(gate)) {
      log(
        `  GoFundMe is not serving this checkout right now (${gate.marker}) — there is nothing ` +
          'to clear; it is asking us to come back later',
      );
      return {
        filled: [],
        manual: ['the whole form (GoFundMe is turning us away for now)'],
        url: page.url(),
        gate,
        rateLimited: true,
      };
    }

    if (gate) {
      log(
        `  GoFundMe is showing a ${gate.kind} challenge — clear it in the browser window and ` +
          'the form will be filled in as soon as it appears',
      );
      const form = await waitPastGate(page, SELECTORS.amountInput, {
        gate,
        confirmGate,
        timeoutMs,
        log,
        what: 'the GoFundMe checkout',
      });
      if (!form) {
        return {
          filled: [],
          manual: ['the whole form (a bot challenge is in the way)'],
          url: page.url(),
          gate,
        };
      }
      await form.dispose();
    }

    // Before anything is typed: this strip covers the bottom of the checkout,
    // which is where the donate button lives.
    const privacy = await dismissPrivacyBanner(page);
    if (privacy.clicked) {
      log(`  closed the privacy banner ("${privacy.clicked}")`);
    } else if (privacy.present) {
      log(
        '  a privacy banner is up and none of its buttons said anything about not sharing — ' +
          'close it yourself if it covers the form',
      );
    }

    const filled = [];
    const manual = [];
    const track = (label, ok) => (ok ? filled : manual).push(label);

    // Which checkout did this campaign get? Everything below depends on it, and
    // the answer is different from one campaign to the next.
    let { layout, fields } = await paymentSurfaces(page);

    // Before anything else, and before the payment methods in particular: the
    // once/monthly choice re-renders the list, and the one mistake that cannot
    // be undone by the donor noticing is a monthly subscription.
    const once = await setGiveOnce(page);
    if (once.acted) track('switched to a one-off donation', once.ok);

    // Then the payment method: revealing the card fields re-renders the form,
    // and anything typed before that can be wiped or lost mid-keystroke.
    await clickFirst(fields, SELECTORS.cardRadio, { timeoutMs: 8000 });
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 15_000 }).catch(() => {});
    await settle();

    // Re-read them afterwards: choosing a method can replace the payment frame
    // outright, and a detached frame answers every question with "not found".
    ({ layout, fields } = await paymentSurfaces(page, { timeoutMs: 10_000 }));

    // Before the amount: switching currency re-renders the field and clears it,
    // and an amount typed into the wrong currency is the wrong donation.
    const currencyResult = await setCurrency(page, currency, { layout });
    track(currencyLabel(currencyResult, currency), currencyResult.ok);

    track('amount', await typeInto(page, SELECTORS.amountInput, String(amount), { timeoutMs: 15_000 }));
    track(tipLabel(tip), await setTip(page, tip));

    const { firstName, lastName } = splitName(donor?.name ?? card.name);
    if (donor?.email) track('email', await typeInto(fields, SELECTORS.email, donor.email, { timeoutMs: 5000 }));
    track('first name', await typeInto(fields, SELECTORS.firstName, firstName, { timeoutMs: 5000 }));
    track('last name', await typeInto(fields, SELECTORS.lastName, lastName, { timeoutMs: 5000 }));

    track('card number', await typeInto(fields, SELECTORS.cardNumber, card.number.replace(/\D/g, ''), { timeoutMs: 10_000 }));
    track('card expiry', await typeInto(fields, SELECTORS.cardExpiry, formatExpiry(card), { timeoutMs: 5000 }));
    track('card cvv', await typeInto(fields, SELECTORS.cardCvv, String(card.cvc), { timeoutMs: 5000 }));
    track('card name', await typeInto(fields, SELECTORS.cardName, card.name, { timeoutMs: 5000 }));
    if (donor?.postalCode) {
      track('postal code', await typeInto(fields, SELECTORS.postalCode, donor.postalCode, { timeoutMs: 5000 }));
    }

    // Never let the site keep the card on file.
    await setCheckbox(fields, SELECTORS.saveCard, false);
    // Still on the page itself in both checkouts, unlike everything above.
    if (donor?.anonymous) track('anonymous', await setCheckbox(page, SELECTORS.anonymous, true));

    // A re-render partway through can drop the amount, and an unnoticed wrong
    // amount is the one mistake worth catching before the user clicks donate.
    const finalAmount = await readValue(page, SELECTORS.amountInput);
    if (parseAmount(finalAmount) !== Number(amount)) {
      await typeInto(page, SELECTORS.amountInput, String(amount), { timeoutMs: 8000 });
      const retried = parseAmount(await readValue(page, SELECTORS.amountInput));
      if (retried !== Number(amount)) {
        const index = filled.indexOf('amount');
        if (index >= 0) filled.splice(index, 1);
        manual.push(`amount (shows ${finalAmount ?? 'nothing'}, wanted ${amount})`);
      }
    }

    return { filled, manual, url: page.url(), layout };
  },

  async waitForConfirmation(page, { timeoutMs, log = () => {} }) {
    return waitForThanks(page, {
      timeoutMs,
      log,
      urlPattern: /\/(thank-you|donation-confirmation|receipt|donate\/success)/i,
      // Taken from a real confirmation page: it says "Thank you for donating to
      // <campaign>" and "You donated $10", not any of the phrasings this used
      // to look for.
      textMarkers: [
        'thank you for donating',
        'you donated',
        'view receipt',
        'thanks for your donation',
        'your donation was successful',
      ],
    });
  },
};

/**
 * Put the checkout in `currency`.
 *
 * The amount is configured in one currency and the checkout opens in whatever
 * GoFundMe thinks fits — the campaign's, or the visitor's. Typing 10 into a
 * page set to EUR donates €10, not $10, so this runs before the amount and its
 * result is reported either way.
 *
 * The payment-elements checkout offers no choice at all: it charges in the
 * fundraiser's own currency. That is not a rotted selector and saying so would
 * send whoever reads the run looking for one, so it is named for what it is —
 * still on the "check this yourself" list, because the donation is then not in
 * the currency the config asked for.
 *
 * @returns {Promise<{ok: boolean, from: string|null, note?: string}>}
 */
export async function setCurrency(page, currency, { layout = null } = {}) {
  const want = String(currency ?? '').toUpperCase();
  if (!want) return { ok: true, from: null };

  const current = (await readText(page, SELECTORS.currencyButton, { timeoutMs: 6000 }))?.trim();
  if (!current) {
    return {
      ok: false,
      from: null,
      note:
        layout === 'payment-elements'
          ? "this checkout has no currency choice — it charges in the fundraiser's own currency"
          : 'no currency control on the page',
    };
  }
  if (current.toUpperCase().startsWith(want)) return { ok: true, from: current };

  if (!(await clickFirst(page, SELECTORS.currencyButton, { timeoutMs: 5000 }))) {
    return { ok: false, from: current, note: `showing ${current}, could not open the currency list` };
  }
  await settle(600);

  // The options read "USD United States dollar"; match the code at the front
  // so "USD" cannot be satisfied by a currency that merely mentions it.
  const chosen = await clickMatching(page, SELECTORS.currencyOption, new RegExp(`^\\s*${want}\\b`, 'i'), {
    timeoutMs: 6000,
  });
  if (!chosen) {
    return { ok: false, from: current, note: `this campaign does not offer ${want} (it is in ${current})` };
  }
  await settle(800);

  const after = (await readText(page, SELECTORS.currencyButton, { timeoutMs: 5000 }))?.trim();
  return after?.toUpperCase().startsWith(want)
    ? { ok: true, from: current }
    : { ok: false, from: current, note: `tried to switch to ${want} but it still shows ${after ?? '?'}` };
}

/** What the currency step is called in the run's output. */
export function currencyLabel(result, currency) {
  if (result.ok && result.from && !result.from.toUpperCase().startsWith(String(currency).toUpperCase())) {
    return `currency ${result.from} -> ${currency}`;
  }
  return result.ok ? `currency (already ${currency})` : `currency: ${result.note}`;
}

/**
 * Close GoFundMe's privacy strip, choosing not to share.
 *
 * The banner is a web component: an empty `#transcend-consent-manager` div with
 * everything real inside a shadow root, so its buttons cannot be reached the
 * way every other control on the page can. It also floats over the bottom of
 * the checkout, which is where the donate button is.
 *
 * Only the wording in `PRIVACY_CHOICES` is pressed, and "accept" is not among
 * it: dismissing a privacy prompt by consenting to everything is not
 * dismissing it. A banner whose buttons are not recognised is left alone and
 * reported — clicking an unknown control on a page holding a card number is
 * not a risk worth taking for tidiness.
 *
 * @returns {Promise<{present: boolean, clicked: string|null}>}
 */
export async function dismissPrivacyBanner(page) {
  // Not `visible`: the host is a zero-size div, and what is on screen belongs
  // to its shadow root.
  const host = await findFirst(page, SELECTORS.privacyBanner, { timeoutMs: 2500, visible: false });
  if (!host) return { present: false, clicked: null };

  const showing = await host
    .evaluate((el) => {
      const root = el.shadowRoot;
      const content = root ? root.textContent : el.textContent;
      return Boolean(content && content.trim().length > 0);
    })
    .catch(() => false);
  await host.dispose();

  // The host sits on every page whether or not the banner is up; an empty one
  // is not something to announce.
  if (!showing) return { present: false, clicked: null };

  const clicked = await clickDeepMatching(page, PRIVACY_CHOICES);
  if (clicked) await settle(700);
  return { present: true, clicked };
}

/**
 * The text of every donate call-to-action on the campaign page.
 *
 * All of them, not the first: a campaign that offers both one-off and monthly
 * giving renders both buttons, and finding "Donate monthly" first would drop
 * somebody who can be donated to perfectly well.
 */
export async function readDonateLabels(page) {
  const selector = SELECTORS.campaignDonateButton.join(', ');
  return page
    .evaluate(
      (query) =>
        [...document.querySelectorAll(query)].map((el) => el.textContent?.trim() ?? ''),
      selector,
    )
    .catch(() => []);
}

/** What the tip step is called in the "filled" / "fill in yourself" lists. */
export function tipLabel(tip) {
  return Number(tip) > 0 ? `tip set to ${Number(tip)}` : 'tip zeroed';
}

/**
 * Force the platform tip to `tip` (an absolute amount, 0 by default).
 *
 * GoFundMe never leaves the tip alone: it pre-selects a percentage of the
 * donation. Zeroing is done with the slider, and any other amount through the
 * custom-tip field, because the slider only stops on the percentages GoFundMe
 * offers. Returning false puts the tip on the "fill in yourself" list rather
 * than letting the site's default quietly stand.
 */
async function setTip(page, tip) {
  const amount = Number(tip) || 0;
  if (amount === 0 && (await zeroTipSlider(page))) return true;
  return setCustomTip(page, amount);
}

/**
 * Drag the tip slider to its minimum. Keyboard Home is more reliable than
 * setting .value, which React ignores unless the native setter is used.
 */
async function zeroTipSlider(page) {
  const slider = await findFirst(page, SELECTORS.tipSlider, { timeoutMs: 6000 });
  if (!slider) return false;
  try {
    await slider.focus();
    await slider.press('Home');
    for (let i = 0; i < 40; i += 1) await slider.press('ArrowLeft');
    const value = await slider.evaluate((el) => Number(el.value));
    return value === 0;
  } catch {
    return false;
  } finally {
    await slider.dispose();
  }
}

/** Type an exact tip into the custom-tip field, revealing it first if needed. */
async function setCustomTip(page, amount) {
  const existing = await findFirst(page, SELECTORS.customTipInput, { timeoutMs: 1500 });
  if (existing) {
    await existing.dispose();
  } else {
    const revealed = await clickMatching(page, SELECTORS.customTipButton, /custom tip|other amount|enter.*tip/i, {
      timeoutMs: 6000,
    });
    if (!revealed) return false;
    await settle(600);
  }

  if (!(await typeInto(page, SELECTORS.customTipInput, String(amount), { timeoutMs: 6000 }))) return false;

  // Confirm rather than assume: this field reformats and clamps what it is
  // given, and an unnoticed tip is money not reaching the family.
  return parseAmount(await readValue(page, SELECTORS.customTipInput)) === amount;
}

/** Set a checkbox to a known state without toggling it the wrong way. */
async function setCheckbox(page, selectors, desired) {
  const handle = await findFirst(page, selectors, { timeoutMs: 4000 });
  if (!handle) return false;
  try {
    const current = await handle.evaluate((el) => el.checked);
    if (current !== desired) await handle.click();
    return true;
  } catch {
    return false;
  } finally {
    await handle.dispose();
  }
}

export default driver;
