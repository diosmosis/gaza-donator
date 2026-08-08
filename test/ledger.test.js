import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, STATUS, budgetFor, round2 } from '../src/ledger.js';

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-'));
  return { file: path.join(dir, 'ledger.jsonl'), dir };
}

const entry = (overrides = {}) => ({
  fqn: '@someone@x',
  campaignUrl: 'https://www.chuffed.org/project/x',
  platform: 'chuffed',
  amount: 10,
  currency: 'USD',
  status: STATUS.SUCCESS,
  ...overrides,
});

test('record then read round-trips, creating the file and its directory', () => {
  const { file } = tempLedger();
  const ledger = new Ledger(file);

  assert.deepEqual(ledger.all(), []);
  ledger.record(entry());
  ledger.record(entry({ fqn: '@other@x', amount: 5 }));

  const all = ledger.all();
  assert.equal(all.length, 2);
  assert.equal(all[0].fqn, '@someone@x');
  assert.ok(Date.parse(all[0].at) > 0);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('a card number never reaches the ledger', () => {
  const { file } = tempLedger();
  const ledger = new Ledger(file);
  ledger.record(entry());
  assert.ok(!/4111|cvc|passphrase/i.test(fs.readFileSync(file, 'utf8')));
});

test('only successful donations count against the budget', () => {
  const { file } = tempLedger();
  const ledger = new Ledger(file);
  ledger.record(entry({ amount: 10, status: STATUS.SUCCESS }));
  ledger.record(entry({ amount: 10, status: STATUS.FAILED }));
  ledger.record(entry({ amount: 10, status: STATUS.SKIPPED }));
  ledger.record(entry({ amount: 10, status: STATUS.ABORTED }));

  assert.equal(ledger.spentSince(new Date(Date.now() - 1000)), 10);
});

test('spentSince and recipientsSince respect the window boundary', () => {
  const { file } = tempLedger();
  const now = Date.now();
  const lines = [
    { at: new Date(now - 10 * 86400_000).toISOString(), fqn: '@old@x', amount: 25, status: 'success' },
    { at: new Date(now - 2 * 86400_000).toISOString(), fqn: '@recent@x', amount: 10, status: 'success' },
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const ledger = new Ledger(file);
  const weekAgo = new Date(now - 7 * 86400_000);
  assert.equal(ledger.spentSince(weekAgo), 10);
  assert.deepEqual([...ledger.recipientsSince(weekAgo)], ['@recent@x']);
  assert.equal(ledger.spentSince(new Date(now - 30 * 86400_000)), 35);
});

test('a truncated final line from a killed run is ignored, not fatal', () => {
  const { file } = tempLedger();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ at: new Date().toISOString(), fqn: '@a@x', amount: 10, status: 'success' })}\n{"at":"2026-`,
  );

  const ledger = new Ledger(file);
  assert.equal(ledger.all().length, 1);
  assert.equal(ledger.spentSince(new Date(Date.now() - 86400_000)), 10);
});

test('a read-only ledger keeps entries in memory and writes nothing', () => {
  const { file } = tempLedger();
  const ledger = new Ledger(file, { readOnly: true });
  ledger.record(entry());

  assert.equal(ledger.all().length, 1);
  assert.equal(ledger.all()[0].dryRun, true);
  assert.ok(!fs.existsSync(file));
});

test('budgetFor turns the remaining budget into whole donations', () => {
  assert.deepEqual(budgetFor({ totalAmount: 200, donationAmount: 10, spent: 0, maxRecipients: 25 }), {
    spent: 0,
    remaining: 200,
    slots: 20,
  });
  assert.deepEqual(budgetFor({ totalAmount: 200, donationAmount: 10, spent: 155, maxRecipients: 25 }), {
    spent: 155,
    remaining: 45,
    slots: 4,
  });
});

test('budgetFor never proposes more recipients than the cap', () => {
  const budget = budgetFor({ totalAmount: 200, donationAmount: 10, spent: 0, maxRecipients: 3 });
  assert.equal(budget.slots, 3);
});

test('budgetFor stops at zero once the period budget is used up', () => {
  const budget = budgetFor({ totalAmount: 200, donationAmount: 10, spent: 205, maxRecipients: 25 });
  assert.equal(budget.remaining, 0);
  assert.equal(budget.slots, 0);
});

test('budgetFor is not defeated by floating point cents', () => {
  // 0.1 * 3 spent against a 0.3 budget must leave a whole donation's worth of nothing.
  const budget = budgetFor({ totalAmount: 30, donationAmount: 10, spent: 10.1 + 10.1 - 0.2, maxRecipients: 25 });
  assert.equal(budget.remaining, 10);
  assert.equal(budget.slots, 1);
});

test('round2 keeps money arithmetic clean', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(10.005), 10.01);
});
