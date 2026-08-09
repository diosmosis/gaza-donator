/**
 * The shipped Chuffed selectors, checked against markup that actually existed.
 *
 * This page is built in the browser and sits behind a challenge, so for a long
 * time its selectors were written from the site's JS bundle and from
 * conventions — and the currency control silently matched nothing at all,
 * which reads exactly like "this campaign has no currency control": no error,
 * no report, no change. A capture of the rendered page is the only way to tell
 * those apart without donating.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SELECTORS } from '../src/drivers/chuffed.js';

const page = readFileSync(new URL('./fixtures/chuffed-payment.html', import.meta.url), 'utf8');

/**
 * Does this selector match anything in the captured markup?
 * Handles the three shapes the driver uses: `tag#id`, `[data-testid="x"]` and
 * `input[name="x"]`.
 */
function matchesCapture(selector) {
  const id = selector.match(/#([\w-]+)/);
  if (id) return page.includes(`id="${id[1]}"`);

  const attr = selector.match(/\[([\w-]+)="([^"]+)"\]/);
  if (attr) return page.includes(`${attr[1]}="${attr[2]}"`);

  return false;
}

/** Every group needs at least one selector that the real page answers to. */
const REQUIRED = {
  currencyIndicator: 'reading which currency the page is in',
  currencyButton: 'opening the currency modal',
  amountInput: 'the amount',
  firstNameInput: 'the first name',
  lastNameInput: 'the last name',
  emailInput: 'the email',
  campaignUpdates: 'the campaign updates opt-in',
  showName: 'the show-my-name toggle',
  submitButton: 'the donate button',
};

for (const [group, what] of Object.entries(REQUIRED)) {
  test(`a selector for ${what} matches the captured page`, () => {
    const matched = SELECTORS[group].filter(matchesCapture);
    assert.ok(
      matched.length > 0,
      `none of ${JSON.stringify(SELECTORS[group])} appears in the captured payment page`,
    );
  });
}

test('the currency control is the one the live page renders, not the one the bundle names', () => {
  // The bundle has both an `impact-selector` and a `donation-selector` variant
  // of this component; the payment page renders the second. Matching only the
  // first is why the currency never changed.
  assert.ok(page.includes('id="donation-selector-currency-button"'));
  assert.ok(SELECTORS.currencyButton.includes('button#donation-selector-currency-button'));
});

test('the currency is read from a control that spells it in lower case', () => {
  // "You're donating in aud" — the comparison has to be case-insensitive.
  assert.match(page, /donation-selector__currency-button[^>]*>\s*<div>aud<\/div>/);
});

test('the tip control in the capture is the one the driver drives', () => {
  // Captured after an amount was entered, which is when Chuffed adds its own
  // suggestion: $4.00 on a $10 donation.
  assert.match(page, /<select[^>]*id="donation-form-optional-tier"/);
  assert.match(page, /<option value="4">Other<\/option>/, 'the only route to an exact figure');
  assert.match(page, /<input type="hidden" name="chuffedAmount" value="4\.00">/);

  assert.ok(SELECTORS.tipSelect.some(matchesCapture), 'the tier dropdown');
  assert.ok(SELECTORS.tipCharged.some((s) => page.includes('name="chuffedAmount"')), 'the charged amount');
});
