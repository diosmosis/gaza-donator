/**
 * URL normalisation and campaign-platform detection.
 *
 * The same campaign is spelled differently depending on where it came from: the
 * gaza.onl API reports `https://www.chuffed.org/project/x` while gaza-verified.org
 * links `https://chuffed.org/project/x`. Everything that compares campaign URLs
 * goes through `normalizeUrl` / `sameCampaign` here.
 */

/** Campaign platforms we know how to drive, keyed by the id used in config. */
export const PLATFORMS = {
  chuffed: {
    id: 'chuffed',
    label: 'Chuffed',
    hosts: ['chuffed.org'],
  },
  gofundme: {
    id: 'gofundme',
    label: 'GoFundMe',
    hosts: ['gofundme.com'],
  },
};

/** Strip a leading `www.` from a hostname. */
function bareHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Reduce a URL to a comparable form: https, no `www.`, no query/hash, no
 * trailing slash, lowercased host (path case is preserved — campaign slugs are
 * case sensitive on some platforms).
 *
 * @returns {string|null} normalised URL, or null if it does not parse.
 */
export function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const path = parsed.pathname.replace(/\/+$/, '');
  return `https://${bareHost(parsed.hostname)}${path}`;
}

/** True when two URLs point at the same campaign, ignoring cosmetic differences. */
export function sameCampaign(a, b) {
  const na = normalizeUrl(a);
  const nb = normalizeUrl(b);
  return na !== null && na === nb;
}

/**
 * Identify which supported platform hosts a campaign URL.
 *
 * @returns {string|null} a key of PLATFORMS, or null for unsupported/unparseable.
 */
export function detectPlatform(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;

  const host = new URL(normalized).hostname;
  for (const platform of Object.values(PLATFORMS)) {
    if (platform.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      return platform.id;
    }
  }
  return null;
}

/** Human label for a platform id, falling back to the raw id. */
export function platformLabel(id) {
  return PLATFORMS[id]?.label ?? id;
}

/** Pull every href out of an HTML string. Used to check gaza-verified listings. */
export function extractLinks(html) {
  if (!html) return [];
  const links = [];
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    links.push(match[2] ?? match[3] ?? match[4]);
  }
  return links;
}
