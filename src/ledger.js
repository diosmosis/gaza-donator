/**
 * Append-only record of every donation attempt, in JSONL.
 *
 * It answers two questions the run depends on:
 *   - how much has already been spent inside the current recurrence window
 *     (the budget is a per-period cap, so this is what limits a run), and
 *   - who has already been paid this period (so a re-run tops up other people
 *     instead of donating twice to the same person).
 *
 * Card details never enter this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.js';

/** Only successful donations consume budget. */
export const STATUS = {
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  ABORTED: 'aborted',
};

export class Ledger {
  /**
   * @param {string} file path to the JSONL ledger
   * @param {object} [options]
   * @param {boolean} [options.readOnly] dry runs record nothing
   */
  constructor(file, { readOnly = false } = {}) {
    this.file = file;
    this.readOnly = readOnly;
    this.pending = []; // dry-run entries, visible to this process only
  }

  /** All entries, oldest first. Unparseable lines are skipped, not fatal. */
  all() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [...this.pending];
    }

    const entries = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // A truncated final line from a killed run: ignore it.
      }
    }
    return entries.concat(this.pending);
  }

  /** Entries recorded at or after `since`. */
  since(since) {
    const cutoff = since instanceof Date ? since.getTime() : new Date(since).getTime();
    return this.all().filter((entry) => {
      const at = Date.parse(entry.at);
      return Number.isFinite(at) && at >= cutoff;
    });
  }

  /** The donations that actually went through since `since`. */
  successesSince(since) {
    return this.since(since).filter((entry) => entry.status === STATUS.SUCCESS);
  }

  /**
   * Total successfully charged to the card since `since`, in the ledger's
   * currency. Platform tips are part of the charge, so they count against the
   * budget alongside the donation itself. Entries written before tips existed
   * have no `tip` field and contribute nothing extra.
   */
  spentSince(since) {
    return this.successesSince(since).reduce((total, entry) => total + chargeOf(entry), 0);
  }

  /** FQNs successfully donated to since `since`. */
  recipientsSince(since) {
    return new Set(this.successesSince(since).map((entry) => entry.fqn).filter(Boolean));
  }

  /**
   * Record an attempt.
   *
   * @param {object} entry
   * @param {string} entry.fqn
   * @param {string} entry.campaignUrl
   * @param {string} entry.platform
   * @param {number} entry.amount
   * @param {number} [entry.tip]   platform tip charged alongside the donation
   * @param {string} entry.currency
   * @param {string} entry.status  one of STATUS
   * @param {string} [entry.note]
   */
  record(entry) {
    const record = {
      at: new Date().toISOString(),
      fqn: entry.fqn,
      campaignUrl: entry.campaignUrl,
      platform: entry.platform,
      amount: entry.amount,
      ...(entry.tip ? { tip: round2(entry.tip) } : {}),
      currency: entry.currency,
      status: entry.status,
      ...(entry.note ? { note: entry.note } : {}),
      ...(this.readOnly ? { dryRun: true } : {}),
    };

    if (this.readOnly) {
      this.pending.push(record);
      return record;
    }

    ensureDir(path.dirname(this.file));
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    return record;
  }
}

/** What one successful attempt took off the card. */
export function chargeOf(entry) {
  return (Number(entry.amount) || 0) + (Number(entry.tip) || 0);
}

/**
 * Budget arithmetic for the current window.
 *
 * @param {object} options
 * @param {number} options.totalAmount    per-period cap
 * @param {number} options.donationAmount amount per recipient
 * @param {number} [options.tipAmount]    platform tip per recipient
 * @param {number} options.spent          already donated this window
 * @param {number} options.maxRecipients
 * @returns {{remaining: number, slots: number, spent: number, perRecipient: number,
 *            capacity: number}}
 */
export function budgetFor({ totalAmount, donationAmount, tipAmount = 0, spent, maxRecipients }) {
  const remaining = Math.max(0, round2(totalAmount - spent));
  // A tip is charged with every donation, so a slot costs both.
  const perRecipient = round2(donationAmount + tipAmount);
  const affordable = Math.floor(remaining / perRecipient + 1e-9);
  // What an untouched budget would have bought. Only reported, never spent
  // against: a run that finds fewer slots than this is usually a run that has
  // already donated some of the period away, and saying so beats re-deriving
  // it from the ledger by hand.
  const capacity = Math.floor(totalAmount / perRecipient + 1e-9);
  return {
    spent: round2(spent),
    remaining,
    perRecipient,
    capacity: Math.max(0, Math.min(capacity, maxRecipients)),
    slots: Math.max(0, Math.min(affordable, maxRecipients)),
  };
}

/** Money is compared and summed in this file; keep it free of float dust. */
export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
