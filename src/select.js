/**
 * Recipient selection: pure functions over data already fetched.
 *
 * The rule from the spec is "those who have received the least amount of money
 * in the last recurrence period should be chosen". The API gives us that
 * ranking directly; this module applies the eligibility filters, breaks ties in
 * a way that avoids paying into abandoned campaigns, and works out how many
 * recipients the remaining budget covers.
 */
import { detectPlatform, extractLinks } from './url.js';
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
 *
 * Some instances serve profile fields as rendered HTML rather than as the bare
 * value, so the anchor is unwrapped: ten of the current accounts are listed
 * that way, and reading the markup as a URL rejected all of them.
 */
export function gazaVerifiedUrl(account) {
  const fields = account?.profile_fields ?? {};
  const key = Object.keys(fields).find(
    (name) => name.trim().toLowerCase() === GAZA_VERIFIED_FIELD.toLowerCase(),
  );
  if (!key) return null;

  const value = String(fields[key] ?? '').trim();
  if (!value) return null;
  if (!value.includes('<')) return value;

  const [href] = extractLinks(value);
  return href ?? null;
}

/**
 * Join the account roster with the per-window donation totals.
 *
 * @param {object[]} accounts     from GazaApi#getAccounts
 * @param {Map} statsIndex        from indexStatsByAccount, over the window
 * @param {Map} [lifetimeIndex]   the same, with no window: everything the API
 *   has recorded for the account, used as the secondary ranking key
 * @returns {object[]} candidate records
 */
export function buildCandidates(accounts, statsIndex, lifetimeIndex = new Map()) {
  return (accounts ?? []).map((account) => {
    const stats = statsIndex.get(account.url) ?? null;
    const lifetime = lifetimeIndex.get(account.url) ?? null;
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
      /** Everything the API has ever recorded for this account. */
      receivedTotal: lifetime?.amount ?? 0,
      currency: stats?.currency ?? lifetime?.currency ?? 'USD',
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
 * Many candidates tie at $0 for a short window, so the tie-breaks matter more
 * than the primary key:
 *
 *   1. received in this recurrence period, ascending — the rule from the spec
 *   2. received in total, ascending — among people the crowd missed this week,
 *      prefer the ones it has been missing all along
 *   3. most recently active, descending — a long-silent account is usually one
 *      whose owner has stopped campaigning (or worse)
 *   4. account URL, so runs are repeatable
 *
 * `total` here is what the API has recorded, which is what we know about every
 * candidate before scraping anything. `rankVerified` re-orders the shortlist on
 * the campaign pages' own figures once those have been read.
 */
export function rankCandidates(candidates) {
  return [...candidates].sort(
    (a, b) =>
      a.receivedInPeriod - b.receivedInPeriod ||
      (a.receivedTotal ?? 0) - (b.receivedTotal ?? 0) ||
      byActivityThenUrl(a, b),
  );
}

function byActivityThenUrl(a, b) {
  const activityA = parseApiTime(a.lastActivityTime) || 0;
  const activityB = parseApiTime(b.lastActivityTime) || 0;
  if (activityA !== activityB) return activityB - activityA;
  return a.accountUrl < b.accountUrl ? -1 : a.accountUrl > b.accountUrl ? 1 : 0;
}

/**
 * How much this campaign has raised in total, best estimate.
 *
 * The campaign page's own figure when verification scraped it, the API's
 * recorded total otherwise — never 0 just because a scrape failed, which would
 * push a candidate we know nothing about to the front of the queue.
 *
 * Page totals are read in whatever currency the campaign runs in, so this is a
 * close-enough comparison, not an exact one. It is a tie-break, not a payment.
 */
export function totalRaised(candidate) {
  const scraped = candidate.verification?.raisedTotal;
  return Number.isFinite(scraped) ? scraped : (candidate.receivedTotal ?? 0);
}

/**
 * Final ordering of the verified shortlist, on the same keys as
 * `rankCandidates` but with the scraped page totals in place of the API's.
 */
export function rankVerified(candidates) {
  return [...candidates].sort(
    (a, b) =>
      a.receivedInPeriod - b.receivedInPeriod ||
      totalRaised(a) - totalRaised(b) ||
      byActivityThenUrl(a, b),
  );
}

/**
 * Full selection pass over already-fetched data.
 *
 * `verify` is optional and async: it receives a candidate and returns
 * `{ok: boolean, note?: string, warnings?: string[], raisedTotal?: number}`.
 *
 * Selection is two-stage, because the campaign page's own raised total — the
 * number worth ranking on — only exists once verification has scraped it, and
 * scraping every candidate would mean hundreds of page loads:
 *
 *   1. rank everyone on what the API knows, and verify down that order until a
 *      shortlist of `slots * poolFactor` candidates has passed,
 *   2. re-rank that shortlist on the page totals now known, and take `slots`.
 *
 * `poolFactor` of 1 verifies exactly as many as are needed, which is the
 * cheapest option and leaves the API's ordering in charge.
 *
 * @returns {Promise<{chosen: object[], rejected: object[], ranked: object[], pool: object[]}>}
 */
export async function selectRecipients({
  candidates,
  platforms,
  includeStates,
  excludeAccounts,
  alreadyDonated,
  slots,
  verify = null,
  poolFactor = 3,
  log = () => {},
  onVerifyStart = () => {},
  onVerifyResult = () => {},
}) {
  const { eligible, rejected } = filterCandidates(candidates, {
    platforms,
    includeStates,
    excludeAccounts,
    alreadyDonated,
  });
  const ranked = rankCandidates(eligible);

  if (slots <= 0) return { chosen: [], rejected, ranked, pool: [] };

  // Without verification there are no page totals to re-rank on, so the API
  // ordering is all there is.
  if (!verify) {
    const chosen = ranked.slice(0, slots).map((candidate) => ({ ...candidate, verification: null }));
    return { chosen, rejected, ranked, pool: chosen };
  }

  const target = Math.min(ranked.length, Math.max(slots, slots * poolFactor));
  const pool = [];
  for (const candidate of ranked) {
    if (pool.length >= target) break;

    // Each verification opens a campaign page, so this loop is where the
    // minutes go; the callbacks let a caller show what it is waiting for.
    onVerifyStart(candidate, { filled: pool.length, target });
    const result = await verify(candidate);
    onVerifyResult(candidate, { ok: Boolean(result?.ok), filled: pool.length, target });

    if (result?.ok) {
      pool.push({ ...candidate, verification: result });
    } else {
      rejected.push({ candidate, reason: result?.note ?? 'verification failed' });
    }
  }

  const ordered = rankVerified(pool);
  const chosen = ordered.slice(0, slots);
  if (ordered.length > chosen.length) {
    log(
      `shortlisted ${ordered.length} verified candidate(s) for ${slots} slot(s); ` +
        'ranked by what each campaign has already raised',
    );
  }

  return { chosen, rejected, ranked, pool: ordered };
}
