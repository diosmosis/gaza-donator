/**
 * The gaza.onl API returns some timestamps without a timezone
 * ("2026-08-04T20:48:22.428000"). They are UTC, but Date.parse treats a naive
 * datetime as local time, which shifts every "last post" reading by the
 * machine's offset — enough to make fresh accounts look stale, or stale ones
 * look fresh, which is exactly what the ranking tie-break depends on.
 */

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** @returns {number} epoch ms, or NaN. */
export function parseApiTime(value) {
  if (!value) return Number.NaN;
  if (value instanceof Date) return value.getTime();

  const text = String(value).trim();
  const isDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text);
  return Date.parse(isDateTime && !HAS_ZONE.test(text) ? `${text.replace(' ', 'T')}Z` : text);
}
