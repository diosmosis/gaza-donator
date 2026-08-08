/**
 * Encrypted card storage.
 *
 * The card lives in a single file, AES-256-GCM, key derived from a passphrase
 * with scrypt. It is decrypted into memory for the duration of a run and never
 * written to the ledger, the cache, logs or debug screenshots — every display
 * path goes through `redactCard`.
 *
 * The intended card is a merchant-locked, spend-limited virtual card
 * (privacy.com or similar), so the blast radius of the file leaking is capped by
 * the card itself as well as by this encryption.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.js';

const VERSION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class CardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CardError';
  }
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_LENGTH, SCRYPT_PARAMS);
}

/** @returns {string} the serialised envelope (JSON). */
export function encryptCard(card, passphrase) {
  if (!passphrase) throw new CardError('a passphrase is required');

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(card), 'utf8'),
    cipher.final(),
  ]);

  return JSON.stringify({
    v: VERSION,
    kdf: 'scrypt',
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

/** Throws CardError on a wrong passphrase or a tampered file (GCM tag check). */
export function decryptCard(envelope, passphrase) {
  let parsed;
  try {
    parsed = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  } catch {
    throw new CardError('card store is corrupt (not valid JSON)');
  }
  if (parsed?.v !== VERSION) throw new CardError(`unsupported card store version: ${parsed?.v}`);

  const salt = Buffer.from(parsed.salt, 'base64');
  const key = crypto.scryptSync(Buffer.from(passphrase ?? '', 'utf8'), salt, KEY_LENGTH, {
    N: parsed.N ?? SCRYPT_PARAMS.N,
    r: parsed.r ?? SCRYPT_PARAMS.r,
    p: parsed.p ?? SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));

  let plaintext;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new CardError('could not decrypt the card: wrong passphrase, or the file was modified');
  }

  try {
    return JSON.parse(plaintext);
  } catch {
    throw new CardError('card store is corrupt (decrypted content is not JSON)');
  }
}

export class CardStore {
  constructor(file) {
    this.file = file;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  /** Write the card, 0600. Any previous card is replaced. */
  save(card, passphrase) {
    validateCard(card);
    ensureDir(path.dirname(this.file));
    fs.writeFileSync(this.file, encryptCard(card, passphrase), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600); // an existing file keeps its old mode otherwise
    return this.file;
  }

  load(passphrase) {
    if (!this.exists()) {
      throw new CardError(`no card stored yet — run \`palestine-donator card set\` first`);
    }
    return decryptCard(fs.readFileSync(this.file, 'utf8'), passphrase);
  }

  clear() {
    if (!this.exists()) return false;
    fs.rmSync(this.file, { force: true });
    return true;
  }
}

/** Digits only, for Luhn and for typing into a payment field. */
export function cardDigits(number) {
  return String(number ?? '').replace(/\D/g, '');
}

/** Catches transposed digits before we sit in front of a payment form. */
export function luhnValid(number) {
  const digits = cardDigits(number);
  if (digits.length < 12 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

export function validateCard(card) {
  const problems = [];
  const digits = cardDigits(card?.number);

  if (!digits) problems.push('number is required');
  else if (!luhnValid(digits)) problems.push('number fails the Luhn check — check for a typo');

  const month = Number(card?.expMonth);
  if (!Number.isInteger(month) || month < 1 || month > 12) problems.push('expMonth must be 1-12');

  const year = Number(card?.expYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    problems.push('expYear must be a 4 digit year');
  }

  if (!/^\d{3,4}$/.test(String(card?.cvc ?? ''))) problems.push('cvc must be 3 or 4 digits');
  if (!card?.name) problems.push('name is required');

  if (problems.length > 0) throw new CardError(`invalid card:\n  - ${problems.join('\n  - ')}`);
  return card;
}

/** True once the card's expiry month has passed. */
export function cardExpired(card, now = new Date()) {
  const year = Number(card?.expYear);
  const month = Number(card?.expMonth);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return false;
  // Cards are valid through the last day of the expiry month.
  return new Date(year, month, 1).getTime() <= now.getTime();
}

/** The only representation of a card that is allowed to be printed. */
export function redactCard(card) {
  const digits = cardDigits(card?.number);
  const last4 = digits.slice(-4) || '????';
  const month = String(card?.expMonth ?? '?').padStart(2, '0');
  const year = String(card?.expYear ?? '????');
  return {
    masked: `•••• ${last4}`,
    expiry: `${month}/${year}`,
    name: card?.name ?? '(no name)',
    toString() {
      return `•••• ${last4}  exp ${month}/${year}`;
    },
  };
}
