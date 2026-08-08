/**
 * Reading an amount *and its currency* out of what a campaign page displays.
 *
 * This matters because the campaign totals are the final ranking key and the
 * campaigns are not all in one currency: a Chuffed campaign showing "$942" may
 * be AUD, and a GoFundMe page showing "€6,909" is EUR. Comparing those numbers
 * as if they were the same unit puts the money in the wrong hands.
 */

/**
 * Symbols that name exactly one currency, longest first so that "CA$" is not
 * read as "$". A bare "$" is deliberately absent: it is ambiguous, and the
 * caller supplies what it means for that platform.
 */
export const CURRENCY_SYMBOLS = [
  ['A$', 'AUD'],
  ['AU$', 'AUD'],
  ['CA$', 'CAD'],
  ['C$', 'CAD'],
  ['NZ$', 'NZD'],
  ['NT$', 'TWD'],
  ['HK$', 'HKD'],
  ['MX$', 'MXN'],
  ['R$', 'BRL'],
  ['US$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₪', 'ILS'],
  ['₹', 'INR'],
  ['₺', 'TRY'],
  ['zł', 'PLN'],
  ['Kč', 'CZK'],
  ['kr', 'SEK'],
  ['CHF', 'CHF'],
];

const ISO = /(?:^|[^A-Z])([A-Z]{3})(?:[^A-Z]|$)/;

/**
 * Parse "€6,909 raised of €20,000" or "AUD 1,234.50" into an amount and, when
 * the text says so, a currency.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string|null} [options.defaultCurrency] what a bare "$" means here
 * @returns {{amount: number, currency: string|null}|null}
 */
export function parseMoney(text, { defaultCurrency = null } = {}) {
  if (text === null || text === undefined) return null;
  const raw = String(text).replace(/,/g, '');

  const match = raw.match(/(\d+(?:\.\d+)?)\s*([kKmM])?\b/);
  if (!match) return null;

  const scale = match[2]?.toLowerCase() === 'k' ? 1000 : match[2]?.toLowerCase() === 'm' ? 1e6 : 1;
  const amount = Number(match[1]) * scale;

  return { amount, currency: detectCurrency(raw, match.index ?? 0, defaultCurrency) };
}

/**
 * Which currency the number at `at` is written in.
 * Looks just before the number, then just after it, then for an ISO code
 * anywhere in the text, and only then falls back to the platform's default.
 */
function detectCurrency(text, at, defaultCurrency) {
  const before = text.slice(Math.max(0, at - 4), at);
  const after = text.slice(at).replace(/^\d+(?:\.\d+)?\s*/, '').slice(0, 5);

  for (const [symbol, currency] of bySymbolLength()) {
    if (before.endsWith(symbol) || after.startsWith(symbol)) return currency;
  }

  const iso = ISO.exec(`${before} ${after}`) ?? ISO.exec(text);
  if (iso && iso[1] !== 'THE') return iso[1];

  // A bare "$" (or no marker at all): the caller knows what its platform means.
  return defaultCurrency;
}

let sorted = null;
function bySymbolLength() {
  sorted ??= [...CURRENCY_SYMBOLS].sort((a, b) => b[0].length - a[0].length);
  return sorted;
}
