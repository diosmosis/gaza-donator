import test from 'node:test';
import assert from 'node:assert/strict';
import { createConverter, fetchRates } from '../src/fx.js';

const RATES = { AUD: 1.4204, EUR: 0.86693, GBP: 0.74352, USD: 1 };

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return handler(url, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

test('rates are fetched for the configured base currency', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ base: 'USD', rates: RATES }));
  const table = await fetchRates('USD', { fetch: fetchImpl });

  assert.equal(table.rates.AUD, 1.4204);
  assert.ok(fetchImpl.calls[0].includes('USD'));
});

test('a provider that is down falls through to the next one', async () => {
  const fetchImpl = stubFetch((url, n) =>
    n === 1 ? jsonResponse(null, { ok: false, status: 503 }) : jsonResponse({ rates: RATES }),
  );

  const table = await fetchRates('USD', { fetch: fetchImpl });
  assert.equal(table.provider, 'exchangerate-api');
  assert.equal(fetchImpl.calls.length, 2);
});

test('every provider failing is an error, not a silent zero', async () => {
  const fetchImpl = stubFetch(() => jsonResponse(null, { ok: false, status: 500 }));
  await assert.rejects(() => fetchRates('USD', { fetch: fetchImpl }), /could not fetch exchange rates/);
});

test('converting divides by the quoted rate', async () => {
  const convert = createConverter({
    base: 'USD',
    fetch: stubFetch(() => jsonResponse({ rates: RATES })),
  });

  // A$942 at 1.4204 AUD per USD.
  assert.equal(Math.round((await convert(942, 'AUD')) * 100) / 100, 663.19);
  assert.equal(Math.round((await convert(6909, 'EUR')) * 100) / 100, 7969.5);
});

test('the same currency is returned untouched, without fetching anything', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ rates: RATES }));
  const convert = createConverter({ base: 'USD', fetch: fetchImpl });

  assert.equal(await convert(100, 'USD'), 100);
  assert.equal(await convert(100, 'usd'), 100);
  assert.equal(fetchImpl.calls.length, 0, 'no rates needed to convert USD to USD');
});

test('rates are fetched once per run, not once per candidate', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ rates: RATES }));
  const convert = createConverter({ base: 'USD', fetch: fetchImpl });

  await convert(1, 'AUD');
  await convert(2, 'EUR');
  await convert(3, 'GBP');
  assert.equal(fetchImpl.calls.length, 1);
});

test('an unknown currency converts to null rather than to a guess', async () => {
  const convert = createConverter({
    base: 'USD',
    fetch: stubFetch(() => jsonResponse({ rates: RATES })),
  });

  assert.equal(await convert(100, 'XYZ'), null);
  assert.equal(await convert(100, ''), null);
  assert.equal(await convert(Number.NaN, 'AUD'), null);
});

test('unreachable providers make conversion null, and are not retried per candidate', async () => {
  const fetchImpl = stubFetch(() => {
    throw new Error('offline');
  });
  const convert = createConverter({ base: 'USD', fetch: fetchImpl });

  assert.equal(await convert(100, 'AUD'), null);
  assert.equal(await convert(100, 'EUR'), null);
  assert.equal(fetchImpl.calls.length, 2, 'both providers tried once, then given up on');
});
