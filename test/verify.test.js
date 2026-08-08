/**
 * The Gaza Verified check, against pages captured from the real site.
 * Puppeteer is not exercised here; the browser checks are covered by running
 * `plan` for real (see README).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkGazaVerified, inConfiguredCurrency } from '../src/verify.js';

const withCampaign = readFileSync(
  new URL('./fixtures/gaza-verified-with-campaign.html', import.meta.url),
  'utf8',
);
const withoutCampaign = readFileSync(
  new URL('./fixtures/gaza-verified-no-campaign.html', import.meta.url),
  'utf8',
);

const htmlResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

const fetchReturning = (body, status) => async () => htmlResponse(body, status);

const PROFILE = 'https://gaza-verified.org/people/@Mahmoud2461986@mastodon.social/';
// The fixture links chuffed.org; the API reports www.chuffed.org for the same campaign.
const CAMPAIGN = 'https://www.chuffed.org/project/urgent4mahmoud';
const ACCOUNT = 'https://mastodon.social/@Mahmoud2461986';

test('a listed account whose campaign matches passes', async () => {
  const result = await checkGazaVerified(PROFILE, CAMPAIGN, {
    accountUrl: ACCOUNT,
    fetch: fetchReturning(withCampaign),
  });
  assert.equal(result.ok, true);
  assert.equal(result.warning, undefined);
});

test('a listed account with no published campaign link passes with a warning', async () => {
  // gaza-verified.org often lists only the Mastodon account. Rejecting these
  // would exclude people who are perfectly well verified.
  const result = await checkGazaVerified(
    'https://gaza-verified.org/people/@memefases@mastodon.social/',
    'https://www.chuffed.org/project/189808-help-marwas-family-survive-in-gaza',
    {
      accountUrl: 'https://mastodon.social/@memefases',
      fetch: fetchReturning(withoutCampaign),
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.warning, /no campaign link/);
});

test('a page naming a different campaign is rejected', async () => {
  const result = await checkGazaVerified(PROFILE, 'https://www.chuffed.org/project/somebody-else', {
    accountUrl: ACCOUNT,
    fetch: fetchReturning(withCampaign),
  });
  assert.equal(result.ok, false);
  assert.match(result.note, /different campaign/);
});

test('a page that is not about this account is rejected', async () => {
  const result = await checkGazaVerified(PROFILE, CAMPAIGN, {
    accountUrl: 'https://mastodon.social/@someone-else',
    fetch: fetchReturning(withCampaign),
  });
  assert.equal(result.ok, false);
  assert.match(result.note, /does not mention this account/);
});

test('a missing profile page is rejected', async () => {
  const result = await checkGazaVerified(PROFILE, CAMPAIGN, {
    fetch: fetchReturning('not found', 404),
  });
  assert.equal(result.ok, false);
  assert.match(result.note, /404/);
});

test('a link to somewhere other than gaza-verified.org is rejected without a fetch', async () => {
  let fetched = false;
  const result = await checkGazaVerified('https://evil.example.com/people/@x/', CAMPAIGN, {
    fetch: async () => {
      fetched = true;
      return htmlResponse('');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.note, /evil\.example\.com/);
  assert.equal(fetched, false);
});

test('an account with no Gaza Verified link at all is rejected', async () => {
  const result = await checkGazaVerified(null, CAMPAIGN, { fetch: fetchReturning('') });
  assert.equal(result.ok, false);
});

test('a network failure is reported, not thrown', async () => {
  const result = await checkGazaVerified(PROFILE, CAMPAIGN, {
    fetch: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.note, /ECONNRESET/);
});

/** Converting a campaign's own total into the currency the ranking uses. */

const convertUsd = async (amount, from) => {
  const rates = { AUD: 1.4204, EUR: 0.86693 };
  return rates[from] ? amount / rates[from] : null;
};

test('a total already in the configured currency is used as it stands', async () => {
  const result = await inConfiguredCurrency(
    { raisedTotal: 3640, raisedCurrency: 'USD' },
    'USD',
    convertUsd,
  );
  assert.deepEqual(result, { amount: 3640, original: 3640, currency: 'USD' });
});

test('a total in another currency is converted before it is ranked on', async () => {
  // The Chuffed campaign that displays "$942" is in AUD.
  const result = await inConfiguredCurrency(
    { raisedTotal: 942, raisedCurrency: 'AUD' },
    'USD',
    convertUsd,
  );
  assert.equal(result.amount, 663.19);
  assert.equal(result.original, 942, 'the page figure is kept for display');
  assert.equal(result.currency, 'AUD');
});

test('a total whose currency is unknown is not ranked on at all', async () => {
  const result = await inConfiguredCurrency({ raisedTotal: 500, raisedCurrency: null }, 'USD', convertUsd);

  assert.equal(result.amount, null, 'ranking on an unknown unit is worse than not ranking on it');
  assert.equal(result.original, 500);
  assert.match(result.note, /does not say in which currency/);
});

test('a currency the rates do not cover is reported, not guessed', async () => {
  const result = await inConfiguredCurrency({ raisedTotal: 500, raisedCurrency: 'XYZ' }, 'USD', convertUsd);

  assert.equal(result.amount, null);
  assert.match(result.note, /could not convert the campaign total from XYZ to USD/);
});

test('a page with no total at all stays empty', async () => {
  const result = await inConfiguredCurrency({ raisedTotal: null }, 'USD', convertUsd);
  assert.deepEqual(result, { amount: null, original: null, currency: null });
});
