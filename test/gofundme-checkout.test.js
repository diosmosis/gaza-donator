/**
 * Which document each part of a GoFundMe checkout lives in.
 *
 * GoFundMe is midway through replacing its checkout, and the replacement moves
 * the payment method list, every card field and the donate button into iframes
 * on another origin. `page.$` does not cross that boundary, so the fill found
 * nothing, reported nothing, and handed the donor an empty form — the exact
 * failure this file exists to keep from coming back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findFirstAcross } from '../src/browser.js';
import { SELECTORS, paymentSurfaces, setGiveOnce } from '../src/drivers/gofundme.js';

const PAYMENT_METHODS_URL = 'https://payment-elements.gofundme.com/v1/checkout-payment-methods/consumer';
const SUBMIT_BUTTON_URL = 'https://payment-elements.gofundme.com/v1/checkout-submit-button/consumer';

/** A document holding a fixed set of selectors. */
function fakeFrame(url, selectors = [], { detached = false } = {}) {
  return {
    url: () => url,
    isDetached: () => detached,
    async $(selector) {
      return selectors.includes(selector) ? { selector, dispose: async () => {} } : null;
    },
  };
}

/** A page made of frames. The page itself is the first one. */
function fakePage(frames) {
  const [main] = frames;
  return { ...main, frames: () => frames };
}

test('paymentSurfaces finds the card fields in the newer checkout iframe', async () => {
  const fields = fakeFrame(PAYMENT_METHODS_URL, ['input#card-number']);
  const submit = fakeFrame(SUBMIT_BUTTON_URL, ['[data-testid="card-checkout-submit-button"]']);
  const page = fakePage([fakeFrame('https://www.gofundme.com/f/x/donate', ['input#checkout-donation']), fields, submit]);

  const surfaces = await paymentSurfaces(page, { timeoutMs: 2000 });

  assert.equal(surfaces.layout, 'payment-elements');
  assert.equal(surfaces.fields.url(), PAYMENT_METHODS_URL);
  assert.equal(surfaces.submit.url(), SUBMIT_BUTTON_URL);
});

test('paymentSurfaces keeps the old checkout on the page itself', async () => {
  // Everything is in the campaign page; there is no payment frame to find.
  const main = fakeFrame('https://www.gofundme.com/f/x/donate', ['input#add-card']);
  const page = fakePage([main]);

  const surfaces = await paymentSurfaces(page, { timeoutMs: 2000 });

  assert.equal(surfaces.layout, 'first-party');
  assert.equal(surfaces.fields, page);
  assert.equal(surfaces.submit, page);
});

test('paymentSurfaces falls back to the page when it recognises neither', async () => {
  // Reported rather than waited on forever: the caller lists every field it
  // could not fill, which says more than a hang would.
  const page = fakePage([fakeFrame('https://www.gofundme.com/f/x/donate', [])]);

  const surfaces = await paymentSurfaces(page, { timeoutMs: 600 });

  assert.equal(surfaces.layout, 'unknown');
  assert.equal(surfaces.fields, page);
});

test('paymentSurfaces ignores a payment frame that has detached', async () => {
  // Choosing a payment method can replace the frame outright, and a detached
  // one answers every question with "not found".
  const stale = fakeFrame(PAYMENT_METHODS_URL, ['input#card-number'], { detached: true });
  const page = fakePage([fakeFrame('https://www.gofundme.com/f/x/donate', ['input#add-card']), stale]);

  const surfaces = await paymentSurfaces(page, { timeoutMs: 2000 });

  assert.equal(surfaces.layout, 'first-party');
});

test('the card selectors match both checkouts', async () => {
  // The newer markup renamed the cardholder field and lowercased the CVV's
  // name; the ids the old one used are still there.
  const newCheckout = fakeFrame(PAYMENT_METHODS_URL, [
    '[data-testid="payment-method-radio-CREDIT_CARD"]',
    'input#card-number',
    'input#card-expiration',
    'input[name="card.cvv"]',
    'input[name="cardHolderName"]',
    'input[name="email"]',
    'input[name="firstName"]',
    'input[name="lastName"]',
    'input[name="postalCode"]',
  ]);
  const oldCheckout = fakeFrame('https://www.gofundme.com/f/x/donate', [
    'input#add-card',
    'input#card-number',
    'input#card-expiration',
    'input#card-cvv',
    'input#card-name',
    'input#email-address',
    'input#first-name',
    'input#last-name',
    'input#location-postal-code',
  ]);

  const groups = ['cardRadio', 'cardNumber', 'cardExpiry', 'cardCvv', 'cardName', 'email', 'firstName', 'lastName', 'postalCode'];
  for (const surface of [newCheckout, oldCheckout]) {
    for (const group of groups) {
      const handle = await findFirstAcross([surface], SELECTORS[group], { timeoutMs: 50, visible: false });
      assert.ok(handle, `${group} matches nothing in ${surface.url()}`);
    }
  }
});

test('findFirstAcross searches every surface within one deadline', async () => {
  // Given a timeout each, three frames would take three times as long — all of
  // it spent on documents that do not hold the field.
  const empty = fakeFrame('https://example.test/a', []);
  const holder = fakeFrame('https://example.test/b', ['#wanted']);
  const started = Date.now();

  const handle = await findFirstAcross([empty, empty, holder], ['#wanted'], { timeoutMs: 5000, visible: false });

  assert.ok(handle);
  assert.ok(Date.now() - started < 1000, 'found on the first sweep, not after three timeouts');
});

test('findFirstAcross skips detached frames rather than throwing', async () => {
  const detached = fakeFrame('https://example.test/a', ['#wanted'], { detached: true });
  const live = fakeFrame('https://example.test/b', ['#wanted']);

  const handle = await findFirstAcross([detached, live], ['#wanted'], { timeoutMs: 500, visible: false });

  assert.equal(handle.selector, '#wanted');
});

test('setGiveOnce leaves a checkout that is already one-off alone', async () => {
  const page = oncePage({ selected: true });

  const result = await setGiveOnce(page);

  assert.deepEqual(result, { present: true, acted: false, ok: true });
  assert.equal(page.clicks, 0, 'a needless click re-renders the payment list');
});

test('setGiveOnce switches a checkout that opened on monthly', async () => {
  // Getting this wrong signs the donor up to a recurring charge, which is the
  // one mistake here that outlives the run.
  const page = oncePage({ selected: false, selectsOnClick: true });

  const result = await setGiveOnce(page);

  assert.deepEqual(result, { present: true, acted: true, ok: true });
  assert.equal(page.clicks, 1);
});

test('setGiveOnce reports a switch that did not take', async () => {
  const page = oncePage({ selected: false, selectsOnClick: false });

  const result = await setGiveOnce(page);

  assert.deepEqual(result, { present: true, acted: true, ok: false });
});

test('setGiveOnce says nothing about a checkout without the choice', async () => {
  // The older checkout has no once/monthly control at all.
  const page = { url: () => 'https://www.gofundme.com/f/x/donate', isDetached: () => false, async $() { return null; } };

  assert.deepEqual(await setGiveOnce(page), { present: false, acted: false, ok: true });
});

/** A page whose once/monthly tab reports `selected`, optionally flipping when clicked. */
function oncePage({ selected, selectsOnClick = false }) {
  const state = { selected, clicks: 0 };
  const handle = {
    async evaluate(fn) {
      return fn({ getAttribute: (name) => (name === 'aria-selected' ? String(state.selected) : null) });
    },
    async click() {
      state.clicks += 1;
      if (selectsOnClick) state.selected = true;
    },
    dispose: async () => {},
  };
  return {
    get clicks() {
      return state.clicks;
    },
    url: () => 'https://www.gofundme.com/f/x/donate',
    isDetached: () => false,
    async $(selector) {
      return SELECTORS.giveOnceTab.includes(selector) ? handle : null;
    },
  };
}
