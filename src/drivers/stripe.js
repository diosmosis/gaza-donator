/**
 * Filling Stripe card fields.
 *
 * Stripe renders its inputs inside cross-origin iframes, so they cannot be
 * reached with page.$(). Which iframe is a moving target: it has been
 * `elements-inner-card`, then `elements-inner-payment`, and at the time of
 * writing the Payment Element's inputs live in `elements-inner-accessory-target`.
 * Matching on the frame's name was how this quietly stopped filling anything —
 * the pattern stopped matching, no frame was found, and every card field was
 * reported as one for the user to type in.
 *
 * So nothing here depends on the frame's name. Every Stripe frame is searched
 * for every field, and the wait is for an actual input rather than for a URL.
 */
import { findFirst, typeInto } from '../browser.js';

/** Stripe puts everything it owns on this host, whatever the page is called. */
const STRIPE_FRAME = /js\.stripe\.com/;

/**
 * Field selectors, newest naming first. The `autocomplete` attributes are the
 * most durable of these — Stripe has renamed the ids twice and kept those.
 */
export const FIELDS = {
  number: [
    '#payment-numberInput',
    'input[name="number"]',
    'input[autocomplete="cc-number"]',
    'input[name="cardnumber"]',
    '#Field-numberInput',
  ],
  expiry: [
    '#payment-expiryInput',
    'input[name="expiry"]',
    'input[autocomplete="cc-exp"]',
    'input[name="exp-date"]',
    '#Field-expiryInput',
  ],
  cvc: [
    '#payment-cvcInput',
    'input[name="cvc"]',
    'input[autocomplete="cc-csc"]',
    '#Field-cvcInput',
  ],
  postal: [
    '#payment-postalCodeInput',
    'input[name="postalCode"]',
    'input[autocomplete*="postal-code"]',
    'input[name="postal"]',
    '#Field-postalCodeInput',
  ],
};

/** `MMYY`, which every Stripe expiry field accepts. */
export function formatExpiry(card) {
  const month = String(card.expMonth).padStart(2, '0');
  const year = String(card.expYear).slice(-2);
  return `${month}${year}`;
}

/** Every frame Stripe owns, innermost content included. */
export function stripeFrames(page) {
  return page.frames().filter((frame) => STRIPE_FRAME.test(frame.url()));
}

/**
 * Wait until some Stripe frame is showing a card number field.
 *
 * The Payment Element mounts its iframe well before it renders anything into
 * it, so waiting for the frame is not the same as waiting for the form.
 *
 * @returns {Promise<import('puppeteer').Frame|null>}
 */
export async function waitForCardFields(page, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const frame of stripeFrames(page)) {
      const handle = await findFirst(frame, FIELDS.number, { timeoutMs: 250, visible: false }).catch(
        () => null,
      );
      if (handle) {
        await handle.dispose();
        return frame;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (Date.now() < deadline);

  return null;
}

/**
 * Fill whatever Stripe fields are present.
 *
 * @returns {Promise<{filled: string[], missing: string[]}>}
 */
export async function fillStripeCard(page, card, { timeoutMs = 20_000 } = {}) {
  const ready = await waitForCardFields(page, { timeoutMs });
  if (!ready) return { filled: [], missing: Object.keys(FIELDS) };

  const values = {
    number: card.number.replace(/\D/g, ''),
    expiry: formatExpiry(card),
    cvc: String(card.cvc),
    postal: card.postalCode ?? '',
  };

  // The Payment Element splits its fields across sibling frames, and the frame
  // holding the number is not always the one holding the CVC.
  const frames = [ready, ...stripeFrames(page).filter((frame) => frame !== ready)];

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
