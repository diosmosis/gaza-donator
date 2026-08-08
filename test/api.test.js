import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ApiError, GazaApi, buildUrl, indexStatsByAccount } from '../src/api.js';
import { Cache } from '../src/cache.js';

const stats = JSON.parse(readFileSync(new URL('./fixtures/campaign-stats.json', import.meta.url)));
const accounts = JSON.parse(readFileSync(new URL('./fixtures/accounts.json', import.meta.url)));

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pd-api-'));

/** A fetch stub that records the URLs it was asked for. */
function stubFetch(responder) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return responder(url, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('buildUrl repeats array parameters, as the API expects', () => {
  const url = buildUrl('https://gaza.onl', '/api/v1/campaigns/accounts', {
    group_by: 'account.url',
    sort: ['amount', 'donation.created_at'],
    limit: 5,
    missing: undefined,
    absent: null,
  });
  assert.equal(
    url,
    'https://gaza.onl/api/v1/campaigns/accounts?group_by=account.url&sort=amount&sort=donation.created_at&limit=5',
  );
});

test('getAccountCampaignStats asks for the ranking the selection depends on', async () => {
  const fetchImpl = stubFetch(() => jsonResponse(stats));
  const api = new GazaApi({ fetch: fetchImpl });

  await api.getAccountCampaignStats({ startTime: new Date('2026-08-01T00:00:00Z') });

  const url = new URL(fetchImpl.calls[0]);
  assert.equal(url.pathname, '/api/v1/campaigns/accounts');
  assert.equal(url.searchParams.get('group_by'), 'account.url');
  assert.equal(url.searchParams.get('sort'), 'amount', 'ascending: least funded first');
  assert.equal(url.searchParams.get('start_time'), '2026-08-01T00:00:00.000Z');
  assert.equal(url.searchParams.get('hide_inactive'), 'true');
});

test('getAccountLifetimeStats asks the same question with no time window', async () => {
  const fetchImpl = stubFetch(() => jsonResponse(stats));
  const api = new GazaApi({ fetch: fetchImpl });

  await api.getAccountLifetimeStats();

  const url = new URL(fetchImpl.calls[0]);
  assert.equal(url.pathname, '/api/v1/campaigns/accounts');
  assert.equal(url.searchParams.get('group_by'), 'account.url');
  assert.equal(url.searchParams.has('start_time'), false, 'no window means everything on record');
  assert.equal(url.searchParams.has('end_time'), false);
});

test('getAccounts hides inactive accounts by default', async () => {
  const fetchImpl = stubFetch(() => jsonResponse(accounts));
  const api = new GazaApi({ fetch: fetchImpl });

  const result = await api.getAccounts();
  assert.equal(result.data.length, accounts.length);
  assert.equal(new URL(fetchImpl.calls[0]).searchParams.get('hide_inactive'), 'true');
});

test('indexStatsByAccount flattens the envelope into a per-account lookup', () => {
  const index = indexStatsByAccount(stats);
  assert.equal(index.size, stats.data.length);

  const row = stats.data[1];
  const entry = index.get(row.account.url);
  assert.equal(entry.amount, row.amount.amount);
  assert.equal(entry.currency, 'USD');
  assert.equal(entry.lastActivityTime, row.last_activity_time);
});

test('indexStatsByAccount survives an empty or malformed envelope', () => {
  assert.equal(indexStatsByAccount(null).size, 0);
  assert.equal(indexStatsByAccount({ data: [{}] }).size, 0);
});

test('a 5xx is retried, and the retry is what the caller sees', async () => {
  const fetchImpl = stubFetch((url, call) =>
    call === 1 ? jsonResponse({ detail: 'oops' }, 503) : jsonResponse(accounts),
  );
  const api = new GazaApi({ fetch: fetchImpl, retries: 2 });

  const result = await api.getAccounts();
  assert.equal(result.data.length, accounts.length);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a 4xx is not retried: it will not improve', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ detail: 'bad request' }, 422));
  const api = new GazaApi({ fetch: fetchImpl, retries: 3 });

  await assert.rejects(() => api.getAccounts(), ApiError);
  assert.equal(fetchImpl.calls.length, 1);
});

test('the API is only called once for a repeated request within the TTL', async () => {
  const fetchImpl = stubFetch(() => jsonResponse(accounts));
  const cache = new Cache({ dir: tempDir() });
  const api = new GazaApi({ fetch: fetchImpl, cache });

  const first = await api.getAccounts();
  const second = await api.getAccounts();

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(second.data, first.data);
});

test('different parameters are cached separately', async () => {
  const fetchImpl = stubFetch(() => jsonResponse(accounts));
  const api = new GazaApi({ fetch: fetchImpl, cache: new Cache({ dir: tempDir() }) });

  await api.getAccounts({ hideInactive: true });
  await api.getAccounts({ hideInactive: false });
  assert.equal(fetchImpl.calls.length, 2);
});
