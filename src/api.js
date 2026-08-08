/**
 * Client for the gaza.onl API (https://gaza.onl/api/v1/openapi.json).
 *
 * Two endpoints carry the whole selection step:
 *   GET /accounts                  – the roster, with campaign_url and the
 *                                    "Gaza Verified" profile field
 *   GET /campaigns/accounts        – donations received per account inside a
 *                                    time window, which is exactly the
 *                                    "least funded lately" ranking we need.
 */
import { Cache, cacheKey } from './cache.js';

export const DEFAULT_BASE_URL = 'https://gaza.onl';
const USER_AGENT = 'palestine-donator (+https://github.com/; contact: local user)';

/** Build a URL with repeated keys for array parameters, as FastAPI expects. */
export function buildUrl(baseUrl, path, params = {}) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

export class ApiError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
  }
}

export class GazaApi {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]
   * @param {Cache}  [options.cache]     omit to disable caching entirely
   * @param {typeof fetch} [options.fetch]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.retries]   retries for network/5xx failures
   */
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    cache = null,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    retries = 2,
  } = {}) {
    this.baseUrl = baseUrl;
    this.cache = cache;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  async #fetchJson(url) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetch(url, {
          signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        });
        if (response.status >= 500) {
          throw new ApiError(`server error ${response.status}`, { status: response.status, url });
        }
        if (!response.ok) {
          // 4xx will not improve on retry.
          const body = await response.text().catch(() => '');
          throw Object.assign(
            new ApiError(`request failed: ${response.status} ${body.slice(0, 200)}`, {
              status: response.status,
              url,
            }),
            { fatal: true },
          );
        }
        return await response.json();
      } catch (err) {
        if (err.fatal) throw err;
        lastError = err;
        if (attempt < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ApiError(`request failed after ${this.retries + 1} attempts: ${lastError?.message}`, {
      url,
    });
  }

  async #get(path, params) {
    const url = buildUrl(this.baseUrl, path, params);
    if (!this.cache) return { data: await this.#fetchJson(url), cached: false };

    const { value, cached, ageMs } = await this.cache.wrap(cacheKey('api', path, params), () =>
      this.#fetchJson(url),
    );
    return { data: value, cached, ageMs };
  }

  /**
   * The account roster.
   *
   * @param {object} [options]
   * @param {boolean} [options.hideInactive] drop DELETED and SUSPENDED accounts
   * @returns {Promise<{data: object[], cached: boolean}>}
   */
  async getAccounts({ hideInactive = true } = {}) {
    return this.#get('/api/v1/accounts', { hide_inactive: hideInactive });
  }

  /**
   * Donations received per account inside a window, ascending by amount, so the
   * first entries are the people the crowd has funded least.
   *
   * @param {object} options
   * @param {Date|string} options.startTime
   * @param {Date|string} [options.endTime]
   * @param {string} [options.currency]
   * @returns {Promise<{data: object, cached: boolean}>} a CampaignStats envelope
   */
  async getAccountCampaignStats({ startTime, endTime, currency = 'USD' } = {}) {
    return this.#get('/api/v1/campaigns/accounts', {
      group_by: 'account.url',
      sort: 'amount',
      start_time: toIso(startTime),
      end_time: toIso(endTime),
      currency,
      hide_inactive: true,
    });
  }

  /**
   * The same grouping with no time window: everything the API has ever
   * recorded per account. Used as the secondary ranking key, so that among the
   * many people who received nothing this period, those who have raised least
   * overall come first.
   *
   * This is *not* the campaign page's own lifetime figure — it counts only the
   * donations gaza.onl has observed, and the two diverge in both directions.
   * It orders the field cheaply; the scraped page total decides the final
   * order, in `selectRecipients`.
   *
   * @returns {Promise<{data: object, cached: boolean}>} a CampaignStats envelope
   */
  async getAccountLifetimeStats({ currency = 'USD' } = {}) {
    return this.#get('/api/v1/campaigns/accounts', {
      group_by: 'account.url',
      sort: 'amount',
      currency,
      hide_inactive: true,
    });
  }

  /** Recent donations for one account, newest first. Used for spot checks. */
  async getAccountDonations(account, { startTime, limit = 50, currency = 'USD' } = {}) {
    return this.#get(`/api/v1/campaigns/accounts/${encodeURIComponent(account)}/donations`, {
      start_time: toIso(startTime),
      limit,
      currency,
    });
  }
}

function toIso(value) {
  if (value === undefined || value === null) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Flatten the CampaignStats envelope into `account.url -> received amount`.
 * Accounts the API knows about but that received nothing still appear, with 0.
 *
 * @param {object} stats response from getAccountCampaignStats
 * @returns {Map<string, {amount: number, currency: string, lastDonationTime: string|null}>}
 */
export function indexStatsByAccount(stats) {
  const index = new Map();
  for (const row of stats?.data ?? []) {
    const url = row.account?.url ?? row.group_value?.[0];
    if (!url) continue;
    index.set(url, {
      amount: row.amount?.amount ?? 0,
      currency: row.amount?.currency ?? 'USD',
      lastDonationTime: row.last_donation_time ?? null,
      lastActivityTime: row.last_activity_time ?? null,
    });
  }
  return index;
}

/** Convenience helper for a Cache pointed at the API namespace. */
export function createApiCache(paths, { read = true, ttlMs } = {}) {
  return new Cache({ dir: paths.cacheDir, read, ttlMs });
}
