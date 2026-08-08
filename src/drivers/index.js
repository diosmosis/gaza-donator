/**
 * Platform drivers.
 *
 * Each driver knows how to do three things with a campaign page:
 *   inspect(page, url)              – is it live and taking donations, and how
 *                                     much has it raised (verification step)
 *   prepare(page, {amount, card})   – get to the payment step with the amount
 *                                     and card filled in, ready for the user
 *   waitForConfirmation(page, opts) – resolve once the platform confirms
 *
 * Drivers never click the final submit button: the user does, after clearing
 * the captcha / 3-D Secure challenge.
 */
import { detectPlatform } from '../url.js';
import chuffed from './chuffed.js';
import gofundme from './gofundme.js';

const DRIVERS = { chuffed, gofundme };

/** @returns {object|null} the driver for a campaign URL. */
export function driverFor(campaignUrl) {
  const platform = detectPlatform(campaignUrl);
  return platform ? (DRIVERS[platform] ?? null) : null;
}

export function driverById(id) {
  return DRIVERS[id] ?? null;
}

export { DRIVERS };
