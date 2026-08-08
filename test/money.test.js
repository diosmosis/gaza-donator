import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney } from '../src/money.js';

test('a symbol that names one currency is read as that currency', () => {
  assert.deepEqual(parseMoney('€6,909 raised'), { amount: 6909, currency: 'EUR' });
  assert.deepEqual(parseMoney('£1,200'), { amount: 1200, currency: 'GBP' });
  assert.deepEqual(parseMoney('₪450'), { amount: 450, currency: 'ILS' });
});

test('the dollar variants are not all the same dollar', () => {
  assert.deepEqual(parseMoney('CA$500'), { amount: 500, currency: 'CAD' });
  assert.deepEqual(parseMoney('A$942'), { amount: 942, currency: 'AUD' });
  assert.deepEqual(parseMoney('US$300'), { amount: 300, currency: 'USD' });
});

test('a bare dollar sign is ambiguous, and says so unless told otherwise', () => {
  assert.deepEqual(parseMoney('$3,640'), { amount: 3640, currency: null });
  assert.deepEqual(parseMoney('$3,640', { defaultCurrency: 'USD' }), {
    amount: 3640,
    currency: 'USD',
  });
});

test('an ISO code is read on either side of the number', () => {
  assert.deepEqual(parseMoney('AUD 1,234.50'), { amount: 1234.5, currency: 'AUD' });
  assert.deepEqual(parseMoney('1,234.50 AUD'), { amount: 1234.5, currency: 'AUD' });
});

test('abbreviated amounts are expanded', () => {
  assert.deepEqual(parseMoney('$12.5K raised of $50K', { defaultCurrency: 'USD' }), {
    amount: 12500,
    currency: 'USD',
  });
  assert.equal(parseMoney('€1.2M')?.amount, 1_200_000);
});

test('text with no amount in it is not a number', () => {
  assert.equal(parseMoney('no numbers here'), null);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney(null), null);
});
