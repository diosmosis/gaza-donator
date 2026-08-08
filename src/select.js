/**
 * Recipient selection: pure functions over data already fetched.
 *
 * The rule from the spec is "those who have received the least amount of money
 * in the last recurrence period should be chosen". The API gives us that
 * ranking directly; this module applies the eligibility filters, breaks ties in
 * a way that avoids paying into abandoned campaigns, and works out how many
 * recipients the remaining budget covers.
 */
import { detectPlatform } from './url.js';
import { parseApiTime } from './time.js';

export const GAZA_VERIFIED_FIELD = 'Gaza Verified';

/** Why a candidate was dropped. Surfaced in the plan output. */
export const REASON = {
  NO_CAMPAIGN: 'no campaign link',
  UNSUPPORTED_PLATFORM: 'campaign platform not supported',
  NOT_GAZA_VERIFIED: 'not listed as Gaza Verified',
  STATE: 'account state excluded',
  DISABLED: 'account disabled',
  EXCLUDED: 'excluded by config',
  ALREADY_DONATED: 'already donated this period',
};

/**
 * The gaza-verified.org profile link an account advertises, if any.
 * Its presence is what makes an account "Gaza Verified" for our purposes.
 */
export function gazaVerifiedUrl(account) {
  const fields = account?.profile_fields ?? {};
  const key = Object.keys(fields).find(
    (name) => name.trim().toLowerCase() === GAZA_VERIFIED_FIELD.toLowerCase(),
  );
  return key ? fields[key] : null;
}

/**
 * Join the account roster with the per-window donation totals.
 *
 * @param {object[]} accounts  from GazaApi#getAccounts
 * @param {Map} statsIndex     from indexStatsByAccount
 * @returns {object[]} candidate records
 */
export function buildCandidates(accounts, statsIndex) {
  return (accounts ?? []).map((account) => {
    const stats = statsIndex.get(account.url) ?? null;
    return {
      fqn: account.fqn,
      displayName: account.display_name || account.username,
      accountUrl: account.url,
      campaignUrl: account.campaign_url ?? null,
      platform: detectPlatform(account.campaign_url),
      gazaVerifiedUrl: gazaVerifiedUrl(account),
      state: account.state ?? null,
      disabled: Boolean(account.disabled),
      receivedInPeriod: stats?.amount ?? 0,
      currency: stats?.currency ?? 'USD',
      lastDonationTime: stats?.lastDonationTime ?? null,
      lastActivityTime: stats?.lastActivityTime ?? null,
      hasStats: stats !== null,
      account,
    };
  });
}

/**
 * Apply eligibility rules.
 *
 * @param {object[]} candidates
 * @param {object} options
 * @param {string[]} options.platforms
 * @param {string[]} options.includeStates
 * @param {string[]} options.excludeAccounts  FQNs or campaign URLs
 * @param {Set<string>} [options.alreadyDonated] FQNs paid this period
 * @returns {{eligible: object[], rejected: {candidate: object, reason: string}[]}}
 */
export function filterCandidates(
  candidates,
  { platforms, includeStates, excludeAccounts = [], alreadyDonated = new Set() },
) {
  const excluded = new Set(excludeAccounts.map((value) => String(value).toLowerCase()));
  const allowedStates = new Set(includeStates.map((state) => state.toUpperCase()));
  const eligible = [];
  const rejected = [];

  const reject = (candidate, reason) => rejected.push({ candidate, reason });

  for (const candidate of candidates) {
    if (!candidate.campaignUrl) {
      reject(candidate, REASON.NO_CAMPAIGN);
    } else if (!candidate.platform || !platforms.includes(candidate.platform)) {
      reject(candidate, REASON.UNSUPPORTED_PLATFORM);
    } else if (!candidate.gazaVerifiedUrl) {
      reject(candidate, REASON.NOT_GAZA_VERIFIED);
    } else if (candidate.disabled) {
      reject(candidate, REASON.DISABLED);
    } else if (candidate.state && !allowedStates.has(String(candidate.state).toUpperCase())) {
      reject(candidate, REASON.STATE);
    } else if (
      excluded.has(String(candidate.fqn).toLowerCase()) ||
      excluded.has(String(candidate.campaignUrl).toLowerCase())
    ) {
      reject(candidate, REASON.EXCLUDED);
    } else if (alreadyDonated.has(candidate.fqn)) {
      reject(candidate, REASON.ALREADY_DONATED);
    } else {
      eligible.push(candidate);
    }
  }

  return { eligible, rejected };
}

/**
 * Least funded first.
 *
 * Many candidates tie at $0 for a short window, so the tie-break matters more
 * than the primary key: prefer accounts that have posted recently, since a
 * long-silent account is usually one whose owner has stopped campaigning (or
 * worse). Ties beyond that fall back to the account URL so runs are repeatable.
 */
export function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.receivedInPeriod !== b.receivedInPeriod) return a.receivedInPeriod - b.receivedInPeriod;

    const activityA = parseApiTime(a.lastActivityTime) || 0;
    const activityB = parseApiTime(b.lastActivityTime) || 0;
    if (activityA !== activityB) return activityB - activityA;

    return a.accountUrl < b.accountUrl ? -1 : a.accountUrl > b.accountUrl ? 1 : 0;
  });
}

/**
 * Full selection pass over already-fetched data.
 *
 * `verify` is optional and async: it receives a candidate and returns
 * `{ok: boolean, note?: string, warnings?: string[], raisedTotal?: number}`.
 * Candidates are verified lazily, in rank order, so we only pay for the scrapes
 * we actually need — failures pull the next candidate up into the slot.
 *
 * @returns {Promise<{chosen: object[], rejected: object[], ranked: object[]}>}
 */
export async function selectRecipients({
  candidates,
  platforms,
  includeStates,
  excludeAccounts,
  alreadyDonated,
  slots,
  verify = null,
}) {
  const { eligible, rejected } = filterCandidates(candidates, {
    platforms,
    includeStates,
    excludeAccounts,
    alreadyDonated,
  });
  const ranked = rankCandidates(eligible);

  const chosen = [];
  for (const candidate of ranked) {
    if (chosen.length >= slots) break;

    if (!verify) {
      chosen.push({ ...candidate, verification: null });
      continue;
    }

    const result = await verify(candidate);
    if (result?.ok) {
      chosen.push({ ...candidate, verification: result });
    } else {
      rejected.push({ candidate, reason: result?.note ?? 'verification failed' });
    }
  }

  return { chosen, rejected, ranked };
}
