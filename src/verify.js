/**
 * Verifying a candidate before any money moves.
 *
 * The API is the source of the ranking, but not of truth about whether a
 * campaign is still live or still belongs to the person it names. Three checks,
 * all cached for the same 15 minutes as the API responses:
 *
 *   campaign      – the campaign page loads and is still taking donations
 *   gazaVerified  – gaza-verified.org lists this account, and links to the same
 *                   campaign the API reported (catches a stale or hijacked link)
 *   raisedTotal   – the platform's own raised figure, shown beside the API's
 *
 * The first two can drop a candidate. The third never does: the API only sums
 * donations it has observed, so a divergence is expected and only worth a
 * warning.
 */
import { cacheKey } from './cache.js';
import { driverFor } from './drivers/index.js';
import { detectPlatform, extractLinks, sameCampaign } from './url.js';

const GAZA_VERIFIED_HOST = 'gaza-verified.org';

/**
 * Fetch a gaza-verified.org profile and check it vouches for this person.
 *
 * Plain fetch: the listing pages are server-rendered, so no browser needed.
 *
 * Two distinct facts come out of this page, and conflating them would reject
 * people who are perfectly well verified:
 *
 *   - the page exists and is about this account   → this is the verification
 *   - the page links a campaign                   → optional. gaza-verified.org
 *     often lists only the Mastodon account. When it *does* name a campaign and
 *     that campaign is not the one the API reported, something is wrong (a
 *     stale link, or a hijacked profile), and the candidate is dropped.
 *
 * @returns {Promise<{ok: boolean, note?: string, warning?: string, links?: string[]}>}
 */
export async function checkGazaVerified(
  profileUrl,
  campaignUrl,
  { accountUrl = null, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {},
) {
  if (!profileUrl) return { ok: false, note: 'no Gaza Verified profile link' };

  let host;
  try {
    host = new URL(profileUrl).hostname.replace(/^www\./, '');
  } catch {
    return { ok: false, note: `unparseable Gaza Verified link: ${profileUrl}` };
  }
  if (host !== GAZA_VERIFIED_HOST) {
    return { ok: false, note: `Gaza Verified link points at ${host}, not ${GAZA_VERIFIED_HOST}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let html;
  try {
    const response = await fetchImpl(profileUrl, {
      signal: controller.signal,
      headers: { accept: 'text/html' },
    });
    if (!response.ok) {
      return { ok: false, note: `Gaza Verified page returned HTTP ${response.status}` };
    }
    html = await response.text();
  } catch (err) {
    return { ok: false, note: `could not load the Gaza Verified page: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }

  const links = extractLinks(html);

  if (accountUrl && !links.some((link) => sameCampaign(link, accountUrl))) {
    return {
      ok: false,
      note: 'Gaza Verified page does not mention this account',
      links,
    };
  }

  const campaignLinks = links.filter((link) => detectPlatform(link) !== null);
  if (campaignLinks.length === 0) {
    return {
      ok: true,
      warning: 'gaza-verified.org lists this account but publishes no campaign link to compare',
      links,
    };
  }

  if (!campaignLinks.some((link) => sameCampaign(link, campaignUrl))) {
    return {
      ok: false,
      note:
        `Gaza Verified links a different campaign (${campaignLinks[0]}) ` +
        `than the API reported (${campaignUrl})`,
      links,
    };
  }

  return { ok: true, links };
}

/**
 * Build the `verify` function that selectRecipients calls per candidate.
 *
 * @param {object} options
 * @param {object} options.config
 * @param {import('./browser.js').BrowserSession|null} options.browser
 * @param {import('./cache.js').Cache|null} options.cache
 * @param {(message: string) => void} [options.log]
 * @returns {(candidate: object) => Promise<{ok: boolean, note?: string, warnings: string[], raisedTotal?: number|null}>}
 */
export function createVerifier({ config, browser, cache = null, log = () => {}, fetchImpl }) {
  const checks = config.verify ?? {};

  return async function verify(candidate) {
    const key = cacheKey('verify', candidate.campaignUrl, {
      checks: Object.entries(checks)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name),
    });

    const run = async () => {
      const warnings = [];

      if (checks.gazaVerified) {
        const result = await checkGazaVerified(candidate.gazaVerifiedUrl, candidate.campaignUrl, {
          accountUrl: candidate.accountUrl,
          fetch: fetchImpl,
        });
        if (!result.ok) return { ok: false, note: result.note, warnings };
        if (result.warning) warnings.push(result.warning);
      }

      if (!checks.campaign && !checks.raisedTotal) return { ok: true, warnings };

      const driver = driverFor(candidate.campaignUrl);
      if (!driver) return { ok: false, note: 'no driver for this campaign platform', warnings };
      if (!browser) return { ok: true, warnings: [...warnings, 'browser checks skipped'] };

      let inspection;
      try {
        inspection = await browser.withPage((page) => driver.inspect(page, candidate.campaignUrl));
      } catch (err) {
        return { ok: false, note: `could not open the campaign page: ${err.message}`, warnings };
      }

      if (checks.campaign && !inspection.ok) {
        return { ok: false, note: inspection.note ?? 'campaign check failed', warnings };
      }

      if (checks.raisedTotal) {
        const divergence = raisedDivergence(inspection.raisedTotal, candidate.receivedInPeriod);
        if (divergence) warnings.push(divergence);
      }

      return {
        ok: true,
        warnings,
        raisedTotal: inspection.raisedTotal ?? null,
        payUrl: inspection.payUrl ?? null,
      };
    };

    if (!cache) return run();

    const { value, cached } = await cache.wrap(key, run);
    if (cached) log(`  (verification for ${candidate.fqn} served from cache)`);
    return value;
  };
}

/**
 * The page total is the campaign's lifetime figure and the API total covers one
 * window, so they are not comparable in general. Only flag the case that would
 * actually mislead the ranking: the page shows nothing at all while the API
 * claims recent donations.
 */
function raisedDivergence(pageTotal, apiWindowTotal) {
  if (pageTotal === null || pageTotal === undefined) {
    return 'could not read the raised total from the campaign page';
  }
  if (apiWindowTotal > 0 && pageTotal < apiWindowTotal) {
    return `campaign page shows ${pageTotal} raised in total but the API reports ${apiWindowTotal} received this period`;
  }
  return null;
}
