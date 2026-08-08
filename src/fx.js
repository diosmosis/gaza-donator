/**
 * Exchange rates, so campaign totals in different currencies can be ordered
 * against each other.
 *
 * Only used to compare — never to decide what to pay. The donation amount is
 * always taken from the configuration in the configured currency, and whatever
 * the payment page charges is the platform's own arithmetic.
 *
 * Two free, keyless providers; the second covers currencies the first (ECB
 * data) does not publish.
 */
import { Cache, cacheKey } from './cache.js';

export const PROVIDERS = [
  {
    name: 'frankfurter',
    url: (base) => `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}`,
  },
  {
    name: 'exchangerate-api',
    url: (base) => `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`,
  },
];

/** Rates move slowly and this only orders a list; a stale rate is harmless. */
export const RATES_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Fetch `1 base = n X` for every currency a provider knows.
 *
 * @returns {Promise<{base: string, rates: Record<string, number>, provider: string}>}
 */
export async function fetchRates(base, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const problems = [];

  for (const provider of PROVIDERS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(provider.url(base), {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = await response.json();
      const rates = body?.rates;
      if (!rates || typeof rates !== 'object') throw new Error('no rates in the response');

      return { base, rates, provider: provider.name };
    } catch (err) {
      problems.push(`${provider.name}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`could not fetch exchange rates (${problems.join('; ')})`);
}

/**
 * A converter into `base`, memoised for the run and cached on disk.
 *
 * Returns null rather than a guess when a currency is unknown or the rates
 * cannot be fetched: the caller then falls back to a figure it can trust,
 * instead of ranking on a number that means nothing.
 *
 * @returns {(amount: number, from: string) => Promise<number|null>}
 */
export function createConverter({ base, cache = null, fetch: fetchImpl, log = () => {} }) {
  const target = String(base ?? 'USD').toUpperCase();
  let table = null;
  let failed = false;

  return async function convert(amount, from) {
    if (!Number.isFinite(amount)) return null;
    const source = String(from ?? '').toUpperCase();
    if (!source) return null;
    if (source === target) return amount;

    if (!table && !failed) {
      try {
        table = await load(target, { cache, fetchImpl });
        log(`exchange rates from ${table.provider}${table.cached ? ' (cached)' : ''}`);
      } catch (err) {
        failed = true;
        log(`could not convert currencies: ${err.message}`);
      }
    }
    if (!table) return null;

    const rate = table.rates[source];
    // The provider quotes `1 target = rate source`, so divide to come back.
    return Number.isFinite(rate) && rate > 0 ? amount / rate : null;
  };
}

async function load(base, { cache, fetchImpl }) {
  if (!cache) return { ...(await fetchRates(base, { fetch: fetchImpl })), cached: false };

  const rateCache = cache instanceof Cache ? cache.withTtl(RATES_TTL_MS) : cache;
  const { value, cached } = await rateCache.wrap(cacheKey('fx', base, {}), () =>
    fetchRates(base, { fetch: fetchImpl }),
  );
  return { ...value, cached };
}
