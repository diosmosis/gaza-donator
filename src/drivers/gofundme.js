/**
 * GoFundMe driver.
 *
 * The checkout lives at gofundme.com/f/<slug>/donate and, unlike Chuffed, keeps
 * its card inputs in the first-party page (payments go through Adyen behind the
 * scenes), so every field can be filled directly.
 *
 * Two details matter for donating the amount the user actually asked for:
 *   - GoFundMe pre-selects a tip to itself; `zeroTip` drags it to 0 so the whole
 *     amount reaches the family.
 *   - The card fields only render once the "credit card" payment method is
 *     selected.
 *
 * Selectors observed on the live site (2026-08); see README if they rot.
 */
import { clickFirst, findFirst, pageText, readValue, settle, typeInto } from '../browser.js';
import { waitForThanks } from './chuffed.js';

export const SELECTORS = {
  amountInput: ['input#checkout-donation', 'input[name="donationAmount"]'],
  tipSlider: ['input[type="range"][aria-label="Tip amount"]', 'input[type="range"][aria-label*="tip" i]'],
  customTipButton: ['button.hrt-text-button', 'button[class*="text-button"]'],
  customTipInput: ['input[name*="tip" i]', 'input[id*="tip" i][type="text"]'],
  cardRadio: ['input#add-card', 'input[name="paymentMethod"][value="CREDIT_CARD"]'],
  cardNumber: ['input#card-number', 'input[name="card.number"]'],
  cardExpiry: ['input#card-expiration', 'input[name="card.expirationDate"]'],
  cardCvv: ['input#card-cvv', 'input[name="card.CVV"]'],
  cardName: ['input#card-name', 'input[name="card.name"]'],
  email: ['input#email-address', 'input[name="email"]'],
  firstName: ['input#first-name', 'input[name="firstName"]'],
  lastName: ['input#last-name', 'input[name="lastName"]'],
  postalCode: ['input#location-postal-code', 'input[name="postalCode"]'],
  anonymous: ['input#checkout-optional-anonymous', 'input[name="checkoutPersonalAnonymous"]'],
  saveCard: ['input#save-card', 'input[name="saveCard"]'],
  submitButton: ['button#donate-now', 'button[type="submit"][aria-label*="Donate" i]'],
  raised: ['[data-testid="progress-meter-heading"]', 'h2[class*="progress"]', '.progress-meter_progressMeterHeading__Nb7lL'],
};

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
  if (!text) return null;
  const match = String(text).replace(/,/g, '').match(/([\d.]+)\s*(k|m)?\s*(?:raised|of)/i);
  if (!match) return null;
  const scale = match[2]?.toLowerCase() === 'k' ? 1000 : match[2]?.toLowerCase() === 'm' ? 1e6 : 1;
  return Number(match[1]) * scale;
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

const driver = {
  id: 'gofundme',
  label: 'GoFundMe',

  async inspect(page, campaignUrl) {
    const response = await page.goto(campaignUrl, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    if (status >= 400) return { ok: false, note: `campaign page returned HTTP ${status}` };

    await page.waitForNetworkIdle({ idleTime: 800, timeout: 20_000 }).catch(() => {});

    const text = await pageText(page);
    const closed = CLOSED_MARKERS.find((marker) => text.includes(marker));
    if (closed) return { ok: false, note: `campaign appears closed ("${closed}")` };

    return { ok: true, raisedTotal: parseRaised(text), payUrl: donateUrl(campaignUrl) };
  },

  async prepare(page, { campaignUrl, amount, card, donor }) {
    await page.goto(donateUrl(campaignUrl), { waitUntil: 'domcontentloaded' });
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 30_000 }).catch(() => {});

    const filled = [];
    const manual = [];
    const track = (label, ok) => (ok ? filled : manual).push(label);

    // Choose the payment method first: revealing the card fields re-renders the
    // form, and anything typed before that can be wiped or lost mid-keystroke.
    await clickFirst(page, SELECTORS.cardRadio, { timeoutMs: 8000 });
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 15_000 }).catch(() => {});
    await settle();

    track('amount', await typeInto(page, SELECTORS.amountInput, String(amount), { timeoutMs: 15_000 }));
    track('tip zeroed', await zeroTip(page));

    const { firstName, lastName } = splitName(donor?.name ?? card.name);
    if (donor?.email) track('email', await typeInto(page, SELECTORS.email, donor.email, { timeoutMs: 5000 }));
    track('first name', await typeInto(page, SELECTORS.firstName, firstName, { timeoutMs: 5000 }));
    track('last name', await typeInto(page, SELECTORS.lastName, lastName, { timeoutMs: 5000 }));

    track('card number', await typeInto(page, SELECTORS.cardNumber, card.number.replace(/\D/g, ''), { timeoutMs: 10_000 }));
    track('card expiry', await typeInto(page, SELECTORS.cardExpiry, formatExpiry(card), { timeoutMs: 5000 }));
    track('card cvv', await typeInto(page, SELECTORS.cardCvv, String(card.cvc), { timeoutMs: 5000 }));
    track('card name', await typeInto(page, SELECTORS.cardName, card.name, { timeoutMs: 5000 }));
    if (donor?.postalCode) {
      track('postal code', await typeInto(page, SELECTORS.postalCode, donor.postalCode, { timeoutMs: 5000 }));
    }

    // Never let the site keep the card on file.
    await setCheckbox(page, SELECTORS.saveCard, false);
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

    return { filled, manual, url: page.url() };
  },

  async waitForConfirmation(page, { timeoutMs }) {
    return waitForThanks(page, {
      timeoutMs,
      urlPattern: /\/(thank-you|donation-confirmation|receipt)/i,
      textMarkers: ['thanks for your donation', 'thank you for your donation', 'your donation was successful'],
    });
  },
};

/**
 * Drag the tip slider to its minimum. Keyboard Home is more reliable than
 * setting .value, which React ignores unless the native setter is used.
 */
async function zeroTip(page) {
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
