/**
 * Configuration: defaults <- config file <- CLI overrides, then validated.
 */
import fs from 'node:fs';
import { PLATFORMS } from './url.js';
import { resolvePaths } from './paths.js';
import { round2 } from './ledger.js';
import { formatMoney } from './report.js';

export const DEFAULT_CONFIG = {
  /** Ceiling on donations inside one recurrence period, in `currency`. */
  totalAmount: 200,
  /** Amount handed to each individual recipient. */
  donationAmount: 10,
  /**
   * Optional tip to the fundraising platform itself, per donation, in
   * `currency`. Both GoFundMe and Chuffed ask for one and default it to a
   * nonzero value; 0 means "give the platform nothing", which is what the
   * drivers enforce unless this is raised. It is charged to the same card, so
   * it counts against `totalAmount`.
   */
  tipAmount: 0,
  currency: 'USD',
  /** How far back "least funded" looks, and the width of the budget window. */
  recurrence: 'weekly',
  platforms: ['chuffed', 'gofundme'],
  /** Hard cap on recipients per run, independent of the budget. */
  maxRecipients: 25,
  /**
   * Home-instance suspension states to consider. LIMITED accounts are real
   * people whose instance has limited them; opt in deliberately.
   */
  includeStates: ['ACTIVE'],
  /** Account FQNs (@user@instance) or campaign URLs to never donate to. */
  excludeAccounts: [],
  verify: {
    campaign: true,
    gazaVerified: true,
    raisedTotal: true,
  },
  /** Divergence between scraped and API totals that earns a warning. */
  raisedTotalWarnRatio: 0.5,
  /** Retries per recipient before giving up on them. */
  retries: 2,
  /** Consecutive recipient failures that abort the whole run. */
  maxConsecutiveFailures: 3,
  /** How long to wait for the user to finish a donation in the browser. */
  donationTimeoutMs: 5 * 60 * 1000,
  /** Donor details filled into campaign forms alongside the card. */
  donor: {
    name: null,
    email: null,
    postalCode: null,
    anonymous: true,
  },
};

const RECURRENCE_PRESETS = {
  daily: 1,
  weekly: 7,
  fortnightly: 14,
  biweekly: 14,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
};

/**
 * Turn a recurrence setting into a day count.
 * Accepts a preset name, `Nd`/`Nw`/`Nm` shorthand, or a bare number of days.
 *
 * @returns {number} days
 */
export function recurrenceDays(recurrence) {
  if (typeof recurrence === 'number') {
    if (!Number.isFinite(recurrence) || recurrence <= 0) {
      throw new Error(`invalid recurrence: ${recurrence}`);
    }
    return recurrence;
  }
  if (typeof recurrence !== 'string') {
    throw new Error(`invalid recurrence: ${recurrence}`);
  }

  const key = recurrence.trim().toLowerCase();
  if (key in RECURRENCE_PRESETS) return RECURRENCE_PRESETS[key];

  const match = /^(\d+(?:\.\d+)?)\s*(d|day|days|w|week|weeks|m|month|months)?$/.exec(key);
  if (!match) throw new Error(`invalid recurrence: ${recurrence}`);

  const value = Number(match[1]);
  if (value <= 0) throw new Error(`invalid recurrence: ${recurrence}`);

  const unit = (match[2] ?? 'd')[0];
  const multiplier = unit === 'w' ? 7 : unit === 'm' ? 30 : 1;
  return value * multiplier;
}

/**
 * Start of the current recurrence window.
 *
 * Quantised to 15 minute boundaries so that two runs a few seconds apart ask
 * the API the same question and hit the 15 minute cache, instead of missing it
 * on a start_time that differs by milliseconds.
 */
export function windowStart(config, now = new Date()) {
  const days = recurrenceDays(config.recurrence);
  const bucket = 15 * 60 * 1000;
  const start = now.getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(Math.floor(start / bucket) * bucket);
}

/**
 * What one recipient actually costs the card: the donation plus the platform
 * tip, if any.
 */
export function chargePerRecipient(config) {
  return round2((Number(config.donationAmount) || 0) + (Number(config.tipAmount) || 0));
}

/**
 * How many people this configuration would pay if the whole period budget were
 * spent. This is the number the `maxRecipients` sanity check is about — it
 * depends only on the configuration, not on what has already been donated.
 */
export function impliedRecipients(config) {
  const charge = chargePerRecipient(config);
  if (!(charge > 0)) return 0;
  return Math.floor(config.totalAmount / charge + 1e-9);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge one level of nested plain objects (verify, donor); arrays replace. */
function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? { ...base[key], ...value } : value;
  }
  return out;
}

/** Throws on anything that would produce a nonsensical or unsafe run. */
export function validateConfig(config) {
  const problems = [];

  if (!(config.totalAmount > 0)) problems.push('totalAmount must be greater than 0');
  if (!(config.donationAmount > 0)) problems.push('donationAmount must be greater than 0');
  if (!(Number.isFinite(config.tipAmount) && config.tipAmount >= 0)) {
    problems.push('tipAmount must be 0 or a positive amount');
  }
  if (chargePerRecipient(config) > config.totalAmount) {
    problems.push('donationAmount (plus tipAmount) cannot exceed totalAmount');
  }
  if (!/^[A-Z]{3}$/.test(config.currency ?? '')) {
    problems.push('currency must be a 3 letter code, e.g. USD');
  }

  try {
    recurrenceDays(config.recurrence);
  } catch {
    problems.push(
      `recurrence must be one of ${Object.keys(RECURRENCE_PRESETS).join(', ')} or e.g. "10d"`,
    );
  }

  if (!Array.isArray(config.platforms) || config.platforms.length === 0) {
    problems.push('platforms must be a non-empty array');
  } else {
    for (const platform of config.platforms) {
      if (!(platform in PLATFORMS)) {
        problems.push(`unsupported platform "${platform}" (known: ${Object.keys(PLATFORMS).join(', ')})`);
      }
    }
  }

  if (!Number.isInteger(config.maxRecipients) || config.maxRecipients < 1) {
    problems.push('maxRecipients must be a positive integer');
  }
  if (!Number.isInteger(config.retries) || config.retries < 0) {
    problems.push('retries must be a non-negative integer');
  }
  if (!Number.isInteger(config.maxConsecutiveFailures) || config.maxConsecutiveFailures < 1) {
    problems.push('maxConsecutiveFailures must be a positive integer');
  }
  if (!Array.isArray(config.excludeAccounts)) {
    problems.push('excludeAccounts must be an array');
  }

  if (problems.length > 0) {
    throw new Error(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }

  // The budget on its own would pay more people than maxRecipients allows, so
  // the cap would silently swallow part of the budget every run. That is much
  // more likely to be a typo in an amount than a deliberate choice, so stop
  // here rather than quietly donating less than the configuration says.
  //
  // Deliberately after the throw above (so it reports against validated
  // numbers) and deliberately without an escape hatch: no flag skips it, and
  // every command loads its configuration through here.
  const implied = impliedRecipients(config);
  if (implied > config.maxRecipients) {
    const money = (amount) => formatMoney(amount, config.currency);
    const charge = chargePerRecipient(config);
    const tipNote =
      config.tipAmount > 0 ? ` plus a ${money(config.tipAmount)} platform tip (${money(charge)} each)` : '';
    throw new Error(
      `misconfigured budget: totalAmount ${money(config.totalAmount)} at ` +
        `${money(config.donationAmount)} per recipient${tipNote} would pay up to ${implied} people, ` +
        `but maxRecipients is ${config.maxRecipients}.\n` +
        `  Raise maxRecipients to at least ${implied}, or lower totalAmount to at most ` +
        `${money(round2(charge * config.maxRecipients))}, or raise donationAmount.\n` +
        '  Stopping so nothing is donated against a configuration that may be a typo.',
    );
  }

  return config;
}

/**
 * Load the effective configuration.
 *
 * @param {object} [options]
 * @param {string} [options.file]      explicit config path (--config)
 * @param {object} [options.overrides] CLI overrides, highest precedence
 * @param {object} [options.env]
 */
export function loadConfig({ file, overrides = {}, env = process.env } = {}) {
  const paths = resolvePaths(env);
  const configFile = file ?? paths.configFile;

  let fromFile = {};
  let fileExists = false;
  if (fs.existsSync(configFile)) {
    fileExists = true;
    let raw;
    try {
      raw = fs.readFileSync(configFile, 'utf8');
    } catch (err) {
      throw new Error(`cannot read config ${configFile}: ${err.message}`);
    }
    try {
      fromFile = JSON.parse(raw);
    } catch (err) {
      throw new Error(`config ${configFile} is not valid JSON: ${err.message}`);
    }
    if (!isPlainObject(fromFile)) throw new Error(`config ${configFile} must contain an object`);
  } else if (file) {
    // An explicitly requested file that is missing is a mistake, not a default.
    throw new Error(`config file not found: ${configFile}`);
  }

  const config = validateConfig(merge(merge(DEFAULT_CONFIG, fromFile), overrides));
  return { config, paths, configFile, fileExists };
}
