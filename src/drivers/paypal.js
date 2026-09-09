/**
 * Filling PayPal's guest checkout.
 *
 * Some Chuffed campaigns are set up to take PayPal and nothing else — see
 * `paymentOffer` in the Chuffed driver. Their pay page has no card form on it
 * at all, so the only way to reach one of those families with a card is
 * PayPal's "Pay with debit or credit card" form, which needs no PayPal account.
 *
 * What this fills, and what it deliberately leaves alone:
 *
 *   set first   the billing country, because changing it empties every other
 *               field on the form — see `setCountry`
 *   filled      email, card number, expiry, CVV, first and last name, postcode
 *   left blank  phone number, street address, city. The tool does not hold
 *               them, and a plausible-looking guess on a billing address is
 *               worse than an empty field — it fails at the bank, not here
 *   turned off  "save your info and create a PayPal account", and the
 *               marketing opt-in. Opening an account in someone's name is not
 *               a thing a donation tool should agree to on their behalf
 *   never       "Agree & Pay". A person clicks that, the same as everywhere
 *               else in this tool
 *
 * The guest form is not always on offer: PayPal decides per session and can
 * show a login wall instead. That is a normal outcome rather than a fault, and
 * it is reported rather than worked around.
 */
import { findFirst, readValue, typeInto } from '../browser.js';

/** Anything PayPal serves the checkout from. */
const PAYPAL_HOST = /(^|\.)paypal\.com\//i;

/**
 * Guest-form fields this tool has something to put in.
 *
 * The `autocomplete` attributes are the durable half of these — PayPal renames
 * its ids more often than it changes what a field is for.
 */
export const FIELDS = {
  email: ['input#email', 'input[type="email"][autocomplete="email"]'],
  number: ['input#cardNumber', 'input[autocomplete="cc-number"]', 'input[name="cardnumber"]'],
  expiry: ['input#cardExpiry', 'input[autocomplete="cc-exp"]', 'input[name="exp-date"]'],
  cvc: ['input#cardCvv', 'input[autocomplete="cc-csc"]', 'input[name="cvv"]'],
  'first name': [
    '[data-testid="firstNameInput"]',
    'input#firstName',
    'input[autocomplete="given-name"]',
  ],
  'last name': [
    '[data-testid="lastNameInput"]',
    'input#lastName',
    'input[autocomplete="family-name"]',
  ],
  postcode: ['input#billingPostalCode', 'input[name="billingPostalCode"]'],
};

/**
 * Required by PayPal, not held by this tool. Named individually so the run can
 * say which three boxes to go and type in rather than "the rest of the form".
 */
export const NOT_HELD = {
  phone: ['[data-testid="phone"]', 'input#phone', 'input[autocomplete="tel"]'],
  'street address': ['input#billingLine1', 'input[name="billingLine1"]'],
  city: ['input#billingCity', 'input[name="billingCity"]'],
};

/**
 * Offers PayPal makes that a donation is not the moment to accept. The switch
 * is the one that matters: left on, paying also opens a PayPal account, with a
 * password and date of birth to match.
 */
const DECLINE = {
  'the offer to create a PayPal account': [
    '[data-testid="onboard-options-switch"]',
    'input#Switch_9',
  ],
  'the marketing opt-in': ['input#marketingOptIn', '[data-testid="marketingOptIn"]'],
};

/** Buttons that reveal the guest form when PayPal opens on its login wall. */
const GUEST_BUTTONS = [
  /pay with (?:debit or credit|a )?card/i,
  /debit or credit card/i,
  /pay(?: as a)? guest/i,
  /continue without (?:a |an )?(?:paypal )?account/i,
];

/**
 * The billing country. PayPal picks one from the merchant and the visitor's
 * connection — an Australian charity's checkout opens on Australia — and the
 * rest of the form is built for whatever it picked: which address lines are
 * asked for, how the postcode is validated, which dialling code the phone
 * field takes.
 */
const COUNTRY = ['[data-testid="countrySelector"]', 'select#country'];

/** What the country is put to unless a caller says otherwise. */
export const BILLING_COUNTRY = 'US';

/**
 * Expiry, in both the spellings this field has been seen to want.
 *
 * Typed as bare digits it silently stayed empty; with the separator it takes.
 * Both are offered rather than one guessed at, because the field reformats
 * whatever it accepts and an empty expiry is not visible until the bank
 * declines.
 */
export function expiryCandidates(card) {
  const month = String(card.expMonth).padStart(2, '0');
  const year = String(card.expYear).slice(-2);
  return [`${month}/${year}`, `${month}${year}`];
}

/**
 * The tab PayPal opened in.
 *
 * Chuffed sends the donor to PayPal in the same tab, but a popup is the other
 * way this is commonly done and which one you get is not worth depending on.
 * Polling every tab for a PayPal URL covers both without racing an event.
 *
 * @returns {Promise<import('puppeteer').Page|null>}
 */
export async function findPayPalPage(browser, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const pages = await browser.pages().catch(() => []);
    const found = pages.find((page) => !page.isClosed() && PAYPAL_HOST.test(page.url()));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (Date.now() < deadline);
  return null;
}

/**
 * Get the guest card form on screen.
 *
 * It is often already open, and when it is not there is a button for it under
 * the login box. PayPal can also decline to offer it at all, which is why this
 * reports rather than retries.
 *
 * @returns {Promise<{ok: boolean, note?: string}>}
 */
export async function openGuestForm(page, { timeoutMs = 40_000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  do {
    const card = await findFirst(page, FIELDS.number, { timeoutMs: 500, visible: true });
    if (card) {
      await card.dispose();
      return { ok: true };
    }

    // Not up yet. If PayPal is offering a way in, take it.
    const opened = await clickByText(page, GUEST_BUTTONS);
    if (opened) await new Promise((resolve) => setTimeout(resolve, 2500));
  } while (Date.now() < deadline);

  return {
    ok: false,
    note: 'PayPal did not offer its guest card form — it may be asking you to log in instead',
  };
}

/**
 * Put the billing country where the card expects it — before anything is typed.
 *
 * This has to come first and cannot be moved: **changing the country empties
 * every other field on the form.** Setting it after the card would wipe the
 * card straight back out, and nothing would say so — the boxes would simply be
 * blank again, looking exactly like fields that were never filled.
 *
 * Not every checkout offers every country, so a country PayPal will not take
 * is reported rather than forced; the form is left on whatever it had, which
 * still works.
 *
 * @returns {Promise<{present: boolean, ok: boolean, changed: boolean, from: string|null, note?: string}>}
 */
export async function setCountry(page, code = BILLING_COUNTRY) {
  const selector = await firstMatching(page, COUNTRY);
  if (!selector) return { present: false, ok: true, changed: false, from: null };

  const before = await page
    .$eval(
      selector,
      (el, want) => ({
        value: el.value,
        label: el.options?.[el.selectedIndex]?.text?.trim() ?? null,
        offered: [...(el.options ?? [])].some((option) => option.value === want),
      }),
      code,
    )
    .catch(() => null);

  if (!before) return { present: true, ok: false, changed: false, from: null };
  if (before.value === code) return { present: true, ok: true, changed: false, from: before.label };
  if (!before.offered) {
    return {
      present: true,
      ok: false,
      changed: false,
      from: before.label,
      note: `PayPal does not offer ${code} on this checkout — it stays on ${before.label}`,
    };
  }

  await page.select(selector, code).catch(() => {});
  await settleAfterCountry(page);

  const after = await page.$eval(selector, (el) => el.value).catch(() => null);
  return { present: true, ok: after === code, changed: true, from: before.label };
}

/**
 * Wait for the form PayPal throws away and rebuilds when the country changes.
 *
 * Typing into it before it has come back is typing into nothing, which is not
 * an error anywhere — the keystrokes just go missing.
 */
async function settleAfterCountry(page, { timeoutMs = 15_000 } = {}) {
  await new Promise((resolve) => setTimeout(resolve, 600));
  const card = await findFirst(page, FIELDS.number, { timeoutMs, visible: true });
  if (card) await card.dispose();
  await new Promise((resolve) => setTimeout(resolve, 600));
}

/** Which of these selectors this page actually answers to. */
async function firstMatching(page, selectors) {
  for (const selector of selectors) {
    const handle = await page.$(selector).catch(() => null);
    if (handle) {
      await handle.dispose();
      return selector;
    }
  }
  return null;
}

/**
 * Fill everything the tool holds, and refuse what it should refuse.
 *
 * @param {import('puppeteer').Page} page   the PayPal tab
 * @param {object} options
 * @param {object} options.card
 * @param {object} [options.donor]
 * @returns {Promise<{ok: boolean, filled: string[], manual: string[], note?: string}>}
 */
export async function fillPayPalGuest(
  page,
  { card, donor = null, country = BILLING_COUNTRY, timeoutMs = 40_000 } = {},
) {
  const ready = await openGuestForm(page, { timeoutMs });
  if (!ready.ok) {
    return { ok: false, filled: [], manual: ['the whole PayPal form'], note: ready.note };
  }

  const filled = [];
  const manual = [];

  // Before a single keystroke: this empties the rest of the form, so anything
  // typed first would be silently wiped back out.
  const chosen = await setCountry(page, country);
  if (chosen.changed && chosen.ok) filled.push(`PayPal country ${chosen.from} -> ${country}`);
  else if (chosen.present && !chosen.ok) {
    manual.push(chosen.note ?? `PayPal country — set it to ${country} yourself`);
  }

  const { firstName, lastName } = splitName(donor?.name ?? card.name);
  const values = {
    email: [donor?.email ?? ''],
    number: [String(card.number).replace(/\D/g, '')],
    expiry: expiryCandidates(card),
    cvc: [String(card.cvc)],
    'first name': [firstName],
    'last name': [lastName],
    postcode: [donor?.postalCode ?? ''],
  };

  for (const [label, selectors] of Object.entries(FIELDS)) {
    // Nothing to say about a field this tool was never given a value for.
    const candidates = (values[label] ?? []).filter(Boolean);
    if (candidates.length === 0) continue;
    const ok = await fillVerified(page, selectors, candidates);
    (ok ? filled : manual).push(`PayPal ${label}`);
  }

  // The switch matters more than the rest of the form put together: left on,
  // paying also opens a PayPal account in the donor's name.
  for (const [label, selectors] of Object.entries(DECLINE)) {
    const result = await setSwitch(page, selectors, false);
    if (result === true) filled.push(`declined ${label}`);
    else if (result === false) manual.push(`${label} — turn it off yourself`);
  }

  // Only the boxes that are actually still empty, so the donor is not sent
  // looking for a field PayPal pre-filled or does not ask this country for.
  for (const [label, selectors] of Object.entries(NOT_HELD)) {
    if (await isEmpty(page, selectors)) manual.push(`PayPal ${label} (not stored by this tool)`);
  }

  return { ok: true, filled, manual, country: chosen };
}

/**
 * Type, read back, and top up whatever did not land.
 *
 * PayPal's fields drop keystrokes: a run that sent "Test" left "Te" behind,
 * one that sent "10001" left "1000", and none of it raised anything —
 * `typeInto` reports success the moment it has pressed the keys, so a
 * half-typed card number would reach the bank as a decline nobody could
 * explain.
 *
 * The first instinct, clearing the field and typing it again, made this
 * strictly worse: the clear landed, the retype did not, and fields that had
 * been *partly* right ended up empty. So a short value is topped up from where
 * it got to rather than started over, and the field is only ever cleared when
 * what is in it is wrong rather than incomplete.
 *
 * Candidates are spellings of the same value, tried in turn; the comparison
 * ignores punctuation because these fields reformat what they accept ("0330"
 * becoming "03 / 30").
 */
async function fillVerified(page, selectors, candidates, { attempts = 3 } = {}) {
  // Established once. Without this, a field PayPal does not show this country
  // costs a full typing timeout on every attempt of every spelling — seconds
  // of waiting, repeated, for something already known to be absent.
  // Short, because `openGuestForm` has already waited for this form to be on
  // screen — anything still missing at this point is missing for good.
  const present = await findFirst(page, selectors, { timeoutMs: 1000, visible: false });
  if (!present) return false;
  await present.dispose();

  for (const value of candidates) {
    const want = comparable(value);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const got = comparable(await readValue(page, selectors, { timeoutMs: 2000 }));
      if (got === want) return true;

      const typed =
        got && want.startsWith(got)
          ? // Partly there: carry on from where it stopped rather than
            // throwing away the characters that did land.
            await appendInto(page, selectors, value.slice(charsFor(value, got)))
          : await typeInto(page, selectors, value, { timeoutMs: 2500, delay: 90 }).catch(() => false);

      if (!typed) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    if (comparable(await readValue(page, selectors, { timeoutMs: 2000 })) === want) return true;
  }
  return false;
}

/**
 * How many characters of `value` produced `got` once punctuation is discounted,
 * so the remainder can be typed without repeating any of it.
 */
function charsFor(value, got) {
  let seen = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (seen === got.length) return index;
    if (comparable(value[index])) seen += 1;
  }
  return value.length;
}

/** Type at the end of what is already in the field, without clearing it. */
async function appendInto(page, selectors, rest) {
  if (!rest) return true;
  const handle = await findFirst(page, selectors, { timeoutMs: 4000 });
  if (!handle) return false;
  try {
    await handle.focus();
    await handle.evaluate((el) => {
      const end = String(el.value ?? '').length;
      el.setSelectionRange?.(end, end);
    });
    await handle.type(rest, { delay: 110 });
    return true;
  } catch {
    return false;
  } finally {
    await handle.dispose();
  }
}

/** Field values compared on their content, not on how the field prints it. */
function comparable(value) {
  return String(value ?? '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

/**
 * Turn a switch off, whichever part of it is the one that listens.
 *
 * PayPal's account-creation switch is a hidden input behind a styled control,
 * so clicking the input itself changed nothing — and reported success, because
 * the click landed. The state is read back after every attempt for that reason.
 *
 * @returns {Promise<boolean|null>} null when there is no such control, which is
 *   not a failure: PayPal varies what it offers by country and by session.
 */
async function setSwitch(page, selectors, desired) {
  const handle = await findFirst(page, selectors, { timeoutMs: 1000, visible: false });
  if (!handle) return null;

  try {
    const state = () => handle.evaluate((el) => Boolean(el.checked));
    if ((await state()) === desired) return true;

    // In order of preference: the control itself, the label bound to it, then
    // whatever wraps it.
    const targets = [
      () => handle.click(),
      async () => {
        // Found from inside the page: `CSS.escape` lives in the browser, not
        // in the process driving it.
        const label = await page.evaluateHandle((el) => {
          const id = el.getAttribute('id');
          return id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        }, handle);
        const element = label.asElement();
        if (!element) {
          await label.dispose();
          throw new Error('no label bound to this control');
        }
        try {
          await element.click();
        } finally {
          await label.dispose();
        }
      },
      () => handle.evaluate((el) => el.closest('label, [role="switch"], div')?.click()),
    ];

    for (const attempt of targets) {
      await attempt().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 400));
      if ((await state()) === desired) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle.dispose();
  }
}

/** Split a donor name into the two fields PayPal asks for. */
export function splitName(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** Click the first button whose own text matches one of `patterns`. */
async function clickByText(page, patterns) {
  const handles = await page.$$('button, a, [role="button"]').catch(() => []);
  try {
    for (const handle of handles) {
      const text = await handle.evaluate((el) => (el.textContent ?? '').trim()).catch(() => '');
      if (!text || !patterns.some((pattern) => pattern.test(text))) continue;
      const clicked = await handle.click().then(
        () => true,
        () => false,
      );
      if (clicked) return true;
    }
  } finally {
    for (const handle of handles) await handle.dispose().catch(() => {});
  }
  return false;
}

/** Is this field present and still blank? */
async function isEmpty(page, selectors) {
  const handle = await findFirst(page, selectors, { timeoutMs: 800, visible: false });
  if (!handle) return false;
  try {
    return !(await handle.evaluate((el) => String(el.value ?? '').trim()));
  } catch {
    return false;
  } finally {
    await handle.dispose();
  }
}
