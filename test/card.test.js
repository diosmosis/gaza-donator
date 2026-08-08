import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CardError,
  CardStore,
  cardExpired,
  decryptCard,
  encryptCard,
  luhnValid,
  redactCard,
  validateCard,
} from '../src/card.js';

// A well-known test number: valid under Luhn, not a real card.
const CARD = {
  number: '4111 1111 1111 1111',
  expMonth: 12,
  expYear: 2030,
  cvc: '123',
  name: 'A Donor',
};

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-card-')), 'card.enc');
}

test('a card survives an encrypt/decrypt round trip', () => {
  const envelope = encryptCard(CARD, 'correct horse battery staple');
  assert.deepEqual(decryptCard(envelope, 'correct horse battery staple'), CARD);
});

test('the ciphertext does not leak the card', () => {
  const envelope = encryptCard(CARD, 'passphrase');
  assert.ok(!envelope.includes('4111'));
  assert.ok(!envelope.includes('A Donor'));
});

test('the same card encrypts differently every time', () => {
  assert.notEqual(encryptCard(CARD, 'p'), encryptCard(CARD, 'p'));
});

test('a wrong passphrase is rejected rather than returning garbage', () => {
  const envelope = encryptCard(CARD, 'right');
  assert.throws(() => decryptCard(envelope, 'wrong'), CardError);
});

test('a tampered ciphertext is rejected by the authentication tag', () => {
  const envelope = JSON.parse(encryptCard(CARD, 'p'));
  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  envelope.ciphertext = bytes.toString('base64');

  assert.throws(() => decryptCard(JSON.stringify(envelope), 'p'), CardError);
});

test('a corrupt store fails clearly instead of throwing a parse error', () => {
  assert.throws(() => decryptCard('not json', 'p'), CardError);
  assert.throws(() => decryptCard(JSON.stringify({ v: 99 }), 'p'), CardError);
});

test('CardStore writes an owner-only file and reads it back', () => {
  const file = tempFile();
  const store = new CardStore(file);

  assert.equal(store.exists(), false);
  store.save(CARD, 'passphrase');

  assert.equal(store.exists(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(store.load('passphrase'), CARD);

  assert.equal(store.clear(), true);
  assert.equal(store.exists(), false);
});

test('CardStore replacing a card re-tightens the file mode', () => {
  const file = tempFile();
  const store = new CardStore(file);
  store.save(CARD, 'p');
  fs.chmodSync(file, 0o644);

  store.save({ ...CARD, cvc: '456' }, 'p');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('CardStore explains itself when no card has been stored', () => {
  assert.throws(() => new CardStore(tempFile()).load('p'), /card set/);
});

test('luhnValid catches a transposed digit', () => {
  assert.ok(luhnValid('4111111111111111'));
  assert.ok(luhnValid('5555 5555 5555 4444'));
  assert.ok(!luhnValid('4111111111111112'));
  assert.ok(!luhnValid('411'));
  assert.ok(!luhnValid(''));
});

test('validateCard reports everything wrong at once', () => {
  assert.throws(
    () => validateCard({ number: '1234', expMonth: 13, expYear: 30, cvc: 'abc', name: '' }),
    (err) => {
      assert.match(err.message, /Luhn/);
      assert.match(err.message, /expMonth/);
      assert.match(err.message, /expYear/);
      assert.match(err.message, /cvc/);
      assert.match(err.message, /name/);
      return true;
    },
  );
  assert.doesNotThrow(() => validateCard(CARD));
});

test('cardExpired treats a card as valid through the end of its expiry month', () => {
  const card = { expMonth: 8, expYear: 2026 };
  assert.equal(cardExpired(card, new Date('2026-08-31T23:00:00Z')), false);
  assert.equal(cardExpired(card, new Date('2026-09-02T00:00:00Z')), true);
});

test('redactCard shows only the last four digits', () => {
  const redacted = redactCard(CARD);
  assert.equal(redacted.masked, '•••• 1111');
  assert.equal(redacted.expiry, '12/2030');
  assert.ok(!redacted.toString().includes('4111 1111 1111'));
});

test('redactCard copes with a missing or partial card', () => {
  assert.equal(redactCard(undefined).masked, '•••• ????');
  assert.equal(redactCard({ number: '99' }).masked, '•••• 99');
});
