/**
 * Filling Stripe card fields.
 *
 * Stripe renders its inputs inside cross-origin iframes, so they cannot be
 * reached with page.$(). Both generations are handled: the older Card Element
 * (inputs named cardnumber/exp-date/cvc/postal) and the newer Payment Element
 * (inputs with Field-*Input ids).
 */
import { waitForFrame, typeInto } from '../browser.js';

const CARD_ELEMENT_FRAME = /js\.stripe\.com\/v3\/elements-inner-(card|payment)/;

const FIELDS = {
  number: ['input[name="cardnumber"]', '#Field-numberInput', 'input[autocomplete="cc-number"]'],
  expiry: ['input[name="exp-date"]', '#Field-expiryInput', 'input[autocomplete="cc-exp"]'],
  cvc: ['input[name="cvc"]', '#Field-cvcInput', 'input[autocomplete="cc-csc"]'],
  postal: ['input[name="postal"]', '#Field-postalCodeInput', 'input[autocomplete="postal-code"]'],
};

/** `MM / YY`, the format every Stripe expiry field accepts. */
export function formatExpiry(card) {
  const month = String(card.expMonth).padStart(2, '0');
  const year = String(card.expYear).slice(-2);
  return `${month}${year}`;
}

/**
 * Fill whatever Stripe fields are present.
 *
 * Stripe may split fields across several iframes, so each field is looked up in
 * every candidate frame.
 *
 * @returns {Promise<{filled: string[], missing: string[]}>}
 */
export async function fillStripeCard(page, card, { timeoutMs = 20_000 } = {}) {
  const anchor = await waitForFrame(page, CARD_ELEMENT_FRAME, { timeoutMs });
  if (!anchor) return { filled: [], missing: Object.keys(FIELDS) };

  const frames = page.frames().filter((frame) => CARD_ELEMENT_FRAME.test(frame.url()));
  const values = {
    number: card.number.replace(/\D/g, ''),
    expiry: formatExpiry(card),
    cvc: String(card.cvc),
    postal: card.postalCode ?? '',
  };

  const filled = [];
  const missing = [];
  for (const [field, selectors] of Object.entries(FIELDS)) {
    if (!values[field]) continue;

    let done = false;
    for (const frame of frames) {
      if (await typeInto(frame, selectors, values[field], { timeoutMs: 2500 }).catch(() => false)) {
        done = true;
        break;
      }
    }
    (done ? filled : missing).push(field);
  }
  return { filled, missing };
}
