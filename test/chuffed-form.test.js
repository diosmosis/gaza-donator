/**
 * Chuffed's payment form, against the markup its own `payment.js` bundle ships.
 * The page cannot be opened without clearing a challenge, so the bundle is the
 * only reliable source for these — and guessing at them is what left the card
 * fields empty and the mailing lists untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SELECTORS, setToggle, splitName } from '../src/drivers/chuffed.js';
import { FIELDS, stripeFrames, waitForCardFields } from '../src/drivers/stripe.js';

globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });

/** A checkbox that behaves the way a React-controlled toggle does. */
function togglePage(initial) {
  const box = {
    checked: initial,
    getClientRects: () => [{}],
    click() {
      box.checked = !box.checked;
    },
  };
  return {
    box,
    async $(selector) {
      return selector.includes('isOptIn') || selector.includes('isShowName') || selector.includes('opt-in')
        ? {
            async evaluate(fn, arg) {
              return fn(box, arg);
            },
            async dispose() {},
          }
        : null;
    },
  };
}

test('an opt-in that is on gets turned off', async () => {
  // Mailing lists are opt-in, and this tool is not the one doing the opting.
  const page = togglePage(true);
  assert.equal(await setToggle(page, SELECTORS.campaignUpdates, false), true);
  assert.equal(page.box.checked, false);
});

test('an opt-in that is already off is left alone', async () => {
  const page = togglePage(false);
  assert.equal(await setToggle(page, SELECTORS.campaignUpdates, false), true);
  assert.equal(page.box.checked, false);
});

test('a toggle that is not on the page is not a failure', async () => {
  const page = { async $() { return null; } };
  assert.equal(await setToggle(page, SELECTORS.chuffedUpdates, false), null);
});

test('anonymity means turning "show my name" off, not a box called anonymous', async () => {
  // Chuffed asks whether to show the donor's name rather than whether to hide
  // it; looking for an "anonymous" checkbox found nothing and said nothing.
  const page = togglePage(true);
  assert.equal(await setToggle(page, SELECTORS.showName, false), true);
  assert.equal(page.box.checked, false);
});

test('the selectors are the ones the bundle ships', () => {
  assert.ok(SELECTORS.campaignUpdates.includes('input[name="isOptIn"]'));
  assert.ok(SELECTORS.chuffedUpdates.includes('input[name="isOptInChuffed"]'));
  assert.ok(SELECTORS.showName.includes('input[name="isShowName"]'));
  assert.ok(SELECTORS.amountInput.includes('input#impact-selector-option-other'));
  assert.ok(SELECTORS.firstNameInput.includes('input[name="firstName"]'));
  assert.ok(SELECTORS.submitButton.includes('#js-donate-action-stripe'));
  assert.ok(SELECTORS.currencySave.includes('[data-test="currency-conversion-save"]'));
});

test('the tip is set through the control the page actually offers', () => {
  // A dropdown of tiers plus "Other", the free input that "Other" reveals, and
  // the hidden field that carries what is charged.
  assert.ok(SELECTORS.tipSelect.includes('select#donation-form-optional-tier'));
  assert.ok(SELECTORS.tipCustomInput.includes('[data-testid="optional-donation-custom-input"]'));
  assert.deepEqual(SELECTORS.tipCharged, ['input[type="hidden"][name="chuffedAmount"]']);
});

/** The Stripe frame rename that emptied the card fields. */

const frame = (url) => ({ url: () => url });

test('every frame Stripe owns is searched, whatever it is called this month', () => {
  // The inputs have lived in elements-inner-card, then -payment, and now in
  // elements-inner-accessory-target. Matching on the name is what broke.
  const page = {
    frames: () => [
      frame('https://www.chuffed.org/pay/campaign/x'),
      frame('https://js.stripe.com/v3/elements-inner-accessory-target-ea81.html#a=1'),
      frame('https://js.stripe.com/v3/controller-with-preconnect-c833.html'),
      frame('https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html'),
    ],
  };

  const found = stripeFrames(page).map((f) => f.url());
  assert.equal(found.length, 2);
  assert.ok(found.some((url) => url.includes('accessory-target')));
});

test('the card fields are looked for by what they are, not where they live', () => {
  // The ids Stripe currently ships, plus the two generations before it.
  assert.ok(FIELDS.number.includes('#payment-numberInput'));
  assert.ok(FIELDS.number.includes('input[autocomplete="cc-number"]'));
  assert.ok(FIELDS.expiry.includes('#payment-expiryInput'));
  assert.ok(FIELDS.cvc.includes('#payment-cvcInput'));
  assert.ok(FIELDS.postal.includes('#payment-postalCodeInput'));
});

test('waiting for the card fields gives up rather than hanging', async () => {
  const page = { frames: () => [frame('https://js.stripe.com/v3/elements-inner-x.html')] };
  page.frames()[0].$ = async () => null;
  assert.equal(await waitForCardFields(page, { timeoutMs: 30 }), null);
});

test('splitName fills both Chuffed name fields', () => {
  assert.deepEqual(splitName('Amina Haddad'), { firstName: 'Amina', lastName: 'Haddad' });
  assert.deepEqual(splitName('Prince'), { firstName: 'Prince', lastName: 'Prince' });
  assert.deepEqual(splitName(''), { firstName: '', lastName: '' });
});
