/**
 * Pure driver helpers. The parts that need a browser are covered by running
 * `plan` against the live sites (see README) — a unit test cannot meaningfully
 * stand in for Cloudflare Turnstile or a React checkout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import chuffed, {
  currencyFromGraphql,
  donateButtonClosed,
  parseMoney,
  tipLabel as chuffedTipLabel,
} from '../src/drivers/chuffed.js';
import gofundme, {
  donateUrl,
  takesOneOffDonations,
  formatExpiry,
  parseAmount,
  parseRaised,
  parseRaisedWithCurrency,
  splitName,
  tipLabel,
} from '../src/drivers/gofundme.js';
import { formatExpiry as stripeExpiry } from '../src/drivers/stripe.js';
import { driverFor, driverById } from '../src/drivers/index.js';

test('driverFor picks a driver by campaign host', () => {
  assert.equal(driverFor('https://www.chuffed.org/project/x'), chuffed);
  assert.equal(driverFor('https://chuffed.org/project/x'), chuffed);
  assert.equal(driverFor('https://www.gofundme.com/f/x'), gofundme);
  assert.equal(driverFor('https://whydonate.com/fundraising/x'), null);
  assert.equal(driverFor(null), null);
  assert.equal(driverById('chuffed'), chuffed);
  assert.equal(driverById('nope'), null);
});

test('every driver implements the interface the payment loop calls', () => {
  for (const driver of [chuffed, gofundme]) {
    for (const method of ['inspect', 'prepare', 'waitForConfirmation']) {
      assert.equal(typeof driver[method], 'function', `${driver.id}.${method}`);
    }
  }
});

test('parseMoney reads Chuffed raised figures', () => {
  assert.equal(parseMoney('$3,439'), 3439);
  assert.equal(parseMoney('$1,234.56'), 1234.56);
  assert.equal(parseMoney('Raised of $10,000'), 10000);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney(null), null);
});

test('donateUrl points at the GoFundMe checkout and drops tracking parameters', () => {
  assert.equal(
    donateUrl('https://www.gofundme.com/f/help-a-family'),
    'https://www.gofundme.com/f/help-a-family/donate',
  );
  assert.equal(
    donateUrl('https://www.gofundme.com/f/help-a-family/?utm_source=mastodon#top'),
    'https://www.gofundme.com/f/help-a-family/donate',
  );
});

test('parseRaised reads the GoFundMe progress line', () => {
  assert.equal(parseRaised('$6,909 raised of $20,000 goal'), 6909);
  assert.equal(parseRaised('$12.5K raised of $50K goal'), 12500);
  assert.equal(parseRaised('no numbers here'), null);
});

test('GoFundMe states the currency in the progress line, and it is not always dollars', () => {
  assert.deepEqual(parseRaisedWithCurrency('€6,909 raised of €20,000 goal'), {
    amount: 6909,
    currency: 'EUR',
  });
  assert.deepEqual(parseRaisedWithCurrency('£1,200 raised of £5,000 goal'), {
    amount: 1200,
    currency: 'GBP',
  });
  assert.deepEqual(parseRaisedWithCurrency('CA$800 raised of CA$4,000'), {
    amount: 800,
    currency: 'CAD',
  });
  assert.deepEqual(
    parseRaisedWithCurrency('$6,909 raised of $20,000 goal'),
    { amount: 6909, currency: 'USD' },
    'GoFundMe writes CA$/A$ explicitly, so a bare $ is USD',
  );
});

test('the Chuffed campaign currency comes from its GraphQL traffic, not the page', () => {
  // The page renders every currency as a bare "$", so the symbol says nothing.
  assert.equal(currencyFromGraphql(['{"campaign":{"currency":"AUD","total":942}}']), 'AUD');
  assert.equal(currencyFromGraphql([]), null);
  assert.equal(currencyFromGraphql(['{"nothing":true}']), null);

  // Donations in other currencies appear alongside the campaign's own, which
  // the page repeats.
  const bodies = [
    '{"currency":"USD","supporters":[{"currency":"EUR"},{"currency":"GBP"}]}',
    '{"campaign":{"currency":"USD"}}',
  ];
  assert.equal(currencyFromGraphql(bodies), 'USD');
});

test('parseAmount compares a formatted amount field on its number', () => {
  assert.equal(parseAmount('10'), 10);
  assert.equal(parseAmount('$10.00'), 10);
  assert.equal(parseAmount('1,250.50'), 1250.5);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
});

test('expiry is formatted the way each site expects it', () => {
  const card = { expMonth: 3, expYear: 2030 };
  assert.equal(formatExpiry(card), '03/30', 'GoFundMe uses a separator');
  assert.equal(stripeExpiry(card), '0330', 'Stripe fields insert their own');
});

test('the tip step names the amount it is aiming for', () => {
  // The label is what tells the user, in the "filled" / "fill in yourself"
  // lists, whether the platform is being tipped at all.
  assert.equal(tipLabel(0), 'tip zeroed');
  assert.equal(tipLabel(undefined), 'tip zeroed');
  assert.equal(tipLabel(2.5), 'tip set to 2.5');
  assert.equal(chuffedTipLabel(0), 'Chuffed tip zeroed');
  assert.equal(chuffedTipLabel(1), 'Chuffed tip set to 1');
});

test('splitName fills both GoFundMe name fields', () => {
  assert.deepEqual(splitName('Amina Haddad'), { firstName: 'Amina', lastName: 'Haddad' });
  assert.deepEqual(splitName('Jean Luc  Picard'), { firstName: 'Jean', lastName: 'Luc Picard' });
  assert.deepEqual(splitName('Prince'), { firstName: 'Prince', lastName: 'Prince' });
  assert.deepEqual(splitName(''), { firstName: '', lastName: '' });
});

test('a Chuffed campaign that stopped taking donations is spotted by its button', () => {
  // Everything else about a closed campaign reads as live — the story, the
  // totals, and a donate button still linking to a real /pay/campaign page —
  // so these three signals are all there is to go on.
  assert.equal(
    donateButtonClosed({
      text: 'Donations closed',
      className: 'link-button campaign-container__donate-button --bold --disabled --primary',
    }),
    true,
  );
  assert.equal(donateButtonClosed({ text: 'Donations Closed' }), true);
  assert.equal(donateButtonClosed({ text: 'Closed for donations' }), true);
  assert.equal(donateButtonClosed({ text: 'Donate now', className: 'x --disabled' }), true);
  assert.equal(donateButtonClosed({ text: 'Donate now', ariaDisabled: 'true' }), true);

  assert.equal(
    donateButtonClosed({
      text: 'Donate now',
      className: 'link-button campaign-container__donate-button --bold --primary --largev2',
    }),
    false,
  );
  assert.equal(donateButtonClosed({}), false);
  assert.equal(donateButtonClosed(), false);
});

test('a GoFundMe campaign offering only monthly giving is not donatable', () => {
  // "Donate monthly" on every button is the only thing the page says about it;
  // /donate redirects back to the campaign rather than opening a checkout.
  assert.equal(takesOneOffDonations(['Donate monthly']), false);
  assert.equal(takesOneOffDonations(['Donate monthly', 'Donate monthly', '  ']), false);
  assert.equal(takesOneOffDonations(['Subscribe']), false);

  // One-off giving offered anywhere on the page is enough.
  assert.equal(takesOneOffDonations(['Donate now']), true);
  assert.equal(takesOneOffDonations(['Donate now', 'Donate monthly']), true);
  assert.equal(takesOneOffDonations(['Donate']), true);

  // Nothing read is not a refusal: the page may simply not have rendered.
  assert.equal(takesOneOffDonations([]), true);
  assert.equal(takesOneOffDonations(['', '   ']), true);
  assert.equal(takesOneOffDonations(undefined), true);
});

test('a Chuffed page that takes PayPal only is told apart from one that takes cards', async () => {
  // The page looks entirely normal until section 3, which holds a "Pay via
  // PayPal" button and no card element at all. Reaching for the card fields
  // anyway puts five of them on the "fill in yourself" list, which sends the
  // donor looking for inputs that are not on the page.
  const { paymentOffer, SELECTORS } = await import('../src/drivers/chuffed.js');
  const pageWith = (selectors) => ({
    async $(selector) {
      return selectors.includes(selector) ? { selector, dispose: async () => {} } : null;
    },
  });

  assert.deepEqual(
    await paymentOffer(pageWith(SELECTORS.paypalSubmit)),
    { card: false, paypal: true },
  );
  assert.deepEqual(
    await paymentOffer(pageWith(SELECTORS.cardSubmit)),
    { card: true, paypal: false },
  );
  assert.deepEqual(
    await paymentOffer(pageWith([...SELECTORS.cardSubmit, ...SELECTORS.paypalSubmit])),
    { card: true, paypal: true },
  );

  // Neither is "could not tell", not "refuses cards": the payment section is
  // the last thing this page renders, and the caller falls back to trying.
  assert.deepEqual(await paymentOffer(pageWith([]), { timeoutMs: 400 }), { card: false, paypal: false });
});
