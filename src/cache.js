/**
 * Small disk cache with a 15 minute TTL, used for gaza.onl API responses and for
 * the scraped verification results.
 *
 * Entries are plain JSON files keyed by a hash of the logical request, so a
 * stale or corrupt entry can simply be deleted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.js';

export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Build a stable cache key. Query parameters are sorted so that callers that
 * build them in a different order still hit the same entry.
 *
 * @param {string} namespace e.g. 'api' or 'verify'
 * @param {string} target    URL or other identifier
 * @param {object} [params]  optional parameters; arrays and objects are allowed
 */
export function cacheKey(namespace, target, params = {}) {
  const normalized = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const payload = JSON.stringify([namespace, target, normalized]);
  const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `${namespace}-${hash}`;
}

export class Cache {
  /**
   * @param {object} options
   * @param {string} options.dir      directory to store entries in
   * @param {number} [options.ttlMs]  entry lifetime
   * @param {boolean} [options.read]  when false, always miss (still writes)
   * @param {boolean} [options.write] when false, never persist
   * @param {() => number} [options.now] clock, injectable for tests
   */
  constructor({ dir, ttlMs = DEFAULT_TTL_MS, read = true, write = true, now = Date.now }) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.readEnabled = read;
    this.writeEnabled = write;
    this.now = now;
  }

  #file(key) {
    return path.join(this.dir, `${key}.json`);
  }

  /** @returns {{hit: boolean, value?: unknown, ageMs?: number}} */
  get(key) {
    if (!this.readEnabled) return { hit: false };

    let raw;
    try {
      raw = fs.readFileSync(this.#file(key), 'utf8');
    } catch {
      return { hit: false };
    }

    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return { hit: false }; // corrupt entry: treat as a miss, it will be rewritten
    }

    const ageMs = this.now() - (entry.fetchedAt ?? 0);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > this.ttlMs) return { hit: false };

    return { hit: true, value: entry.value, ageMs };
  }

  set(key, value) {
    if (!this.writeEnabled) return;
    ensureDir(this.dir);
    const tmp = `${this.#file(key)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: this.now(), value }));
    fs.renameSync(tmp, this.#file(key)); // atomic, so a killed run never leaves a partial entry
  }

  /**
   * Cache-aside helper: return the cached value, or call `producer` and store it.
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} producer
   * @returns {Promise<{value: T, cached: boolean, ageMs?: number}>}
   */
  async wrap(key, producer) {
    const found = this.get(key);
    if (found.hit) return { value: found.value, cached: true, ageMs: found.ageMs };

    const value = await producer();
    this.set(key, value);
    return { value, cached: false };
  }

  /** Delete every entry. Returns the number of files removed. */
  clear() {
    let removed = 0;
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      fs.rmSync(path.join(this.dir, name), { force: true });
      removed += 1;
    }
    return removed;
  }
}
