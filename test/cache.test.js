import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cache, DEFAULT_TTL_MS, cacheKey } from '../src/cache.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cache-'));

test('cacheKey ignores parameter order and undefined values', () => {
  assert.equal(
    cacheKey('api', '/accounts', { b: 2, a: 1 }),
    cacheKey('api', '/accounts', { a: 1, b: 2 }),
  );
  assert.equal(
    cacheKey('api', '/accounts', { a: 1 }),
    cacheKey('api', '/accounts', { a: 1, b: undefined, c: null }),
  );
  assert.equal(
    cacheKey('api', '/accounts', { sort: ['b', 'a'] }),
    cacheKey('api', '/accounts', { sort: ['a', 'b'] }),
  );
});

test('cacheKey separates different requests and namespaces', () => {
  assert.notEqual(cacheKey('api', '/accounts', { a: 1 }), cacheKey('api', '/accounts', { a: 2 }));
  assert.notEqual(cacheKey('api', '/x'), cacheKey('verify', '/x'));
});

test('a value written is a value read', () => {
  const cache = new Cache({ dir: tempDir() });
  assert.deepEqual(cache.get('k'), { hit: false });

  cache.set('k', { hello: 'world' });
  const found = cache.get('k');
  assert.equal(found.hit, true);
  assert.deepEqual(found.value, { hello: 'world' });
});

test('an entry expires once it is older than the TTL', () => {
  let now = 1_000_000;
  const cache = new Cache({ dir: tempDir(), now: () => now });

  cache.set('k', 'value');
  now += DEFAULT_TTL_MS - 1000;
  assert.equal(cache.get('k').hit, true, 'still fresh just inside the TTL');

  now += 2000;
  assert.equal(cache.get('k').hit, false, 'stale just outside the TTL');
});

test('read:false forces a miss but still records the fresh value', async () => {
  const dir = tempDir();
  new Cache({ dir }).set('k', 'old');

  const bypassing = new Cache({ dir, read: false });
  assert.equal(bypassing.get('k').hit, false);

  const { value, cached } = await bypassing.wrap('k', async () => 'new');
  assert.equal(value, 'new');
  assert.equal(cached, false);
  assert.equal(new Cache({ dir }).get('k').value, 'new');
});

test('wrap calls the producer exactly once for a repeated request', async () => {
  const cache = new Cache({ dir: tempDir() });
  let calls = 0;
  const producer = async () => {
    calls += 1;
    return calls;
  };

  assert.deepEqual((await cache.wrap('k', producer)).value, 1);
  const second = await cache.wrap('k', producer);
  assert.equal(second.value, 1);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test('a corrupt entry is treated as a miss and overwritten', async () => {
  const dir = tempDir();
  const cache = new Cache({ dir });
  cache.set('k', 'good');
  fs.writeFileSync(path.join(dir, 'k.json'), '{not json');

  assert.equal(cache.get('k').hit, false);
  const { value } = await cache.wrap('k', async () => 'rewritten');
  assert.equal(value, 'rewritten');
  assert.equal(cache.get('k').value, 'rewritten');
});

test('write:false leaves nothing on disk', () => {
  const dir = tempDir();
  new Cache({ dir, write: false }).set('k', 'value');
  assert.equal(fs.existsSync(path.join(dir, 'k.json')), false);
});

test('clear removes entries and tolerates a missing directory', () => {
  const dir = tempDir();
  const cache = new Cache({ dir });
  cache.set('a', 1);
  cache.set('b', 2);

  assert.equal(cache.clear(), 2);
  assert.equal(cache.get('a').hit, false);
  assert.equal(new Cache({ dir: path.join(dir, 'nope') }).clear(), 0);
});
