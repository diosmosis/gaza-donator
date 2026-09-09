/**
 * Keeping a minimum gap between requests to the same site.
 *
 * The crawl runs several pages at once, which is fine spread across hosts and
 * is not fine aimed at one. A roster that is mostly Chuffed means concurrency
 * four is four simultaneous requests to Chuffed, over and over, for the length
 * of the run — and Chuffed answers a burst of that by replacing the donation
 * form with "we have noticed suspicious activity, please try again later" on
 * the pages the donation step actually needs. The crawl is a diagnostic; it is
 * not worth spending the ability to donate on.
 *
 * Pacing per host rather than lowering concurrency keeps a mixed roster moving
 * at full speed while still queueing behind a single busy site. The gap is
 * measured between *starts*, so a slow page does not earn the next one a free
 * pass — and nothing is ever pushed further back than it needs to be.
 */

/** The host a URL belongs to, or the URL itself if it will not parse. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url);
  }
}

/**
 * Build a `pace(url)` that resolves when it is this request's turn.
 *
 * @param {object} [options]
 * @param {number} [options.minGapMs] the least time between two starts on one host
 * @param {() => number} [options.now]   injectable clock, for tests
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable, for tests
 * @returns {(url: string) => Promise<number>} how long it waited, in ms
 */
export function createPacer({
  minGapMs = 750,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /** host -> the earliest moment the next request to it may start. */
  const earliest = new Map();

  return async function pace(url) {
    if (minGapMs <= 0) return 0;

    const host = hostOf(url);
    const at = Math.max(now(), earliest.get(host) ?? 0);

    // Claimed before awaiting, so requests that arrive together queue behind
    // each other rather than all reading the same free slot and taking it.
    earliest.set(host, at + minGapMs);

    const waitMs = at - now();
    if (waitMs > 0) await sleep(waitMs);
    return Math.max(0, waitMs);
  };
}
