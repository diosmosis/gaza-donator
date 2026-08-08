/**
 * The diagnostic, driven with a fake browser and fake drivers: no network, no
 * Chrome. What is tested is the classification — which findings mean "the
 * campaign is gone" and which mean "our selectors rotted" — since that is what
 * a person reads at the end of a ten minute run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { KIND, checkCampaign, checkCampaigns, mapPool, summarise } from '../src/check.js';

const candidate = (overrides = {}) => ({
  fqn: '@someone@x',
  displayName: 'Someone',
  platform: 'chuffed',
  campaignUrl: 'https://www.chuffed.org/project/x',
  ...overrides,
});

/** A browser whose pages report whatever the driver stub wants. */
const fakeBrowser = () => ({
  pages: 0,
  async withPage(fn) {
    this.pages += 1;
    return fn({ goto: async () => ({ status: () => 200 }), waitForNetworkIdle: async () => {} });
  },
  async close() {},
});

const driverReturning = (inspection, form = null) => () => ({
  id: 'fake',
  form,
  inspect: async () => (inspection instanceof Error ? Promise.reject(inspection) : inspection),
});

const GOOD = { ok: true, raisedTotal: 1200, raisedCurrency: 'USD', payUrl: 'https://pay/x' };

test('a campaign that parses completely has no problems', async () => {
  const result = await checkCampaign(candidate(), {
    browser: fakeBrowser(),
    resolveDriver: driverReturning(GOOD),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.details.raisedTotal, 1200);
});

test('a dead campaign is reported against the campaign, not against our parsing', async () => {
  const result = await checkCampaign(candidate(), {
    browser: fakeBrowser(),
    resolveDriver: driverReturning({ ok: false, note: 'campaign page returned HTTP 404' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.problems[0].kind, KIND.CAMPAIGN);
  assert.match(result.problems[0].message, /404/);
});

test('each thing the tool depends on is checked separately', async () => {
  const result = await checkCampaign(candidate(), {
    browser: fakeBrowser(),
    resolveDriver: driverReturning({ ok: true, raisedTotal: null, raisedCurrency: null, payUrl: null }),
  });

  const messages = result.problems.map((problem) => problem.message);
  assert.equal(result.problems.every((problem) => problem.kind === KIND.PARSE), true);
  assert.equal(messages.length, 3, 'total, currency and donate link are three findings');
  assert.match(messages.join('\n'), /raised total/);
  assert.match(messages.join('\n'), /currency/);
  assert.match(messages.join('\n'), /donate link/);
});

test('a currency with no exchange rate is a finding, since it cannot be ranked on', async () => {
  const result = await checkCampaign(candidate(), {
    browser: fakeBrowser(),
    resolveDriver: driverReturning({ ...GOOD, raisedCurrency: 'XYZ' }),
    convert: async () => null,
  });

  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /no exchange rate for XYZ/);
});

test('a converted total is recorded for the report', async () => {
  const result = await checkCampaign(candidate(), {
    browser: fakeBrowser(),
    resolveDriver: driverReturning({ ...GOOD, raisedCurrency: 'AUD', raisedTotal: 942 }),
    convert: async (amount) => amount / 1.4204,
  });

  assert.equal(result.ok, true);
  assert.equal(result.details.converted, 663.19);
});

test('a page that will not open at all is a finding, not a crash', async () => {
  const result = await checkCampaign(candidate(), {
    browser: fakeBrowser(),
    resolveDriver: driverReturning(new Error('net::ERR_CONNECTION_REFUSED')),
  });

  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /ERR_CONNECTION_REFUSED/);
});

test('missing payment controls are reported where the form renders', async () => {
  const form = {
    gated: false,
    url: () => 'https://pay/x',
    fields: { amount: ['#a'], submit: ['#b'] },
  };
  const browser = {
    async withPage(fn) {
      return fn({
        goto: async () => ({ status: () => 200 }),
        waitForNetworkIdle: async () => {},
        // Only the amount field is still there.
        $: async (selector) => (selector === '#a' ? { dispose: async () => {} } : null),
      });
    },
  };

  const result = await checkCampaign(candidate(), {
    browser,
    deep: true,
    resolveDriver: driverReturning(GOOD, form),
  });

  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /payment form is missing: submit/);
});

test('a gated form that renders nothing is inconclusive, not a broken selector', async () => {
  // Chuffed's payment page never clears its challenge headless; reporting that
  // as rotted selectors every run would train the reader to ignore the report.
  const form = { gated: true, url: () => 'https://pay/x', fields: { amount: ['#a'], submit: ['#b'] } };
  const browser = {
    async withPage(fn) {
      return fn({
        goto: async () => ({ status: () => 200 }),
        waitForNetworkIdle: async () => {},
        $: async () => null,
      });
    },
  };

  const result = await checkCampaign(candidate(), {
    browser,
    deep: true,
    resolveDriver: driverReturning(GOOD, form),
  });

  assert.equal(result.ok, true, 'nothing was learned, so nothing is claimed');
  assert.match(result.inconclusive[0], /bot protection/);
});

test('an unsupported platform is reported rather than skipped silently', async () => {
  const result = await checkCampaign(candidate({ platform: null }), {
    browser: fakeBrowser(),
    resolveDriver: () => null,
  });

  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /no driver/);
});

test('one campaign blowing up does not end the run', async () => {
  const candidates = [candidate({ fqn: '@a@x' }), candidate({ fqn: '@b@x' })];
  const results = await checkCampaigns({
    candidates,
    browser: fakeBrowser(),
    concurrency: 2,
    pause: noPause,
    resolveDriver: (url) => ({
      id: 'fake',
      inspect: async () => {
        throw Object.assign(new Error('boom'), { url });
      },
    }),
  });

  assert.equal(results.length, 2);
  assert.equal(results.every((result) => !result.ok), true);
});

test('progress is reported for every campaign, in order', async () => {
  const seen = [];
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((id) => candidate({ fqn: `@${id}@x` }));

  const results = await checkCampaigns({
    candidates,
    browser: fakeBrowser(),
    concurrency: 2,
    resolveDriver: driverReturning(GOOD),
    onResult: (result) => seen.push(result.fqn),
  });

  assert.equal(seen.length, 5, 'one progress tick per campaign');
  assert.deepEqual(
    results.map((result) => result.fqn),
    candidates.map((c) => c.fqn),
    'results stay in candidate order regardless of who finishes first',
  );
});

test('mapPool runs at most `limit` at a time and preserves order', async () => {
  let running = 0;
  let peak = 0;

  const results = await mapPool([1, 2, 3, 4, 5, 6], 2, async (value) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return value * 2;
  });

  assert.equal(peak, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
});

test('the summary groups the same failure across many campaigns', async () => {
  const groups = summarise([
    { problems: [{ kind: KIND.CAMPAIGN, message: 'campaign page returned HTTP 404' }] },
    { problems: [{ kind: KIND.CAMPAIGN, message: 'campaign page returned HTTP 410' }] },
    { problems: [{ kind: KIND.PARSE, message: 'raised total could not be read from the page' }] },
    { problems: [{ kind: KIND.PARSE, message: 'raised total could not be read from the page' }] },
    { problems: [{ kind: KIND.PARSE, message: 'raised total could not be read from the page' }] },
  ]);

  assert.equal(groups[0].count, 3, 'the most common problem comes first');
  assert.match(groups[0].message, /raised total/);
  assert.equal(groups[1].count, 2, 'two HTTP codes are one kind of problem');
  assert.match(groups[1].message, /HTTP N/);
});

const noPause = async () => {};

test('a finding has to reproduce before it is reported', async () => {
  // These pages render themselves in the browser and go slow under load; a
  // single miss said more about the site's mood than about our selectors, and
  // an early version of this reported 83 live campaigns as having no donate
  // button.
  let attempt = 0;
  const results = await checkCampaigns({
    candidates: [candidate()],
    browser: fakeBrowser(),
    pause: noPause,
    resolveDriver: () => ({
      id: 'fake',
      inspect: async () => {
        attempt += 1;
        return attempt === 1 ? { ok: false, note: 'no donate button on the campaign page' } : GOOD;
      },
    }),
  });

  assert.equal(results[0].ok, true);
  assert.equal(attempt, 2);
  assert.deepEqual(results[0].clearedOnRetry, ['no donate button on the campaign page']);
});

test('a finding that reproduces is reported, once', async () => {
  let attempts = 0;
  const results = await checkCampaigns({
    candidates: [candidate()],
    browser: fakeBrowser(),
    pause: noPause,
    resolveDriver: () => ({
      id: 'fake',
      inspect: async () => {
        attempts += 1;
        return { ok: false, note: 'campaign page returned HTTP 404' };
      },
    }),
  });

  assert.equal(attempts, 2, 'checked twice');
  assert.equal(results[0].ok, false);
  assert.equal(results[0].problems.length, 1, 'reported once');
  assert.equal(results[0].retried, true);
});

test('retrying can be turned off for a quick pass', async () => {
  let attempts = 0;
  await checkCampaigns({
    candidates: [candidate()],
    browser: fakeBrowser(),
    retryFailures: false,
    resolveDriver: () => ({
      id: 'fake',
      inspect: async () => {
        attempts += 1;
        return { ok: false, note: 'gone' };
      },
    }),
  });
  assert.equal(attempts, 1);
});

test('the re-check happens after the crawl, not in the middle of it', async () => {
  // The sites slow down under sustained load; a retry issued while that load is
  // still on learns nothing the first attempt did not. Eight of the campaigns
  // an earlier version reported as broken passed when asked again afterwards.
  const order = [];
  const candidates = ['a', 'b', 'c'].map((id) => candidate({ fqn: `@${id}@x` }));

  await checkCampaigns({
    candidates,
    browser: fakeBrowser(),
    concurrency: 1,
    pause: async () => order.push('pause'),
    onRecheck: (count) => order.push(`recheck ${count}`),
    resolveDriver: () => ({
      id: 'fake',
      inspect: async () => {
        const seen = order.filter((step) => step.startsWith('check')).length;
        order.push('check');
        // @b@x fails the first time round and passes on the second pass.
        return seen === 1 ? { ok: false, note: 'no donate button on the campaign page' } : GOOD;
      },
    }),
  });

  assert.deepEqual(order, ['check', 'check', 'check', 'recheck 1', 'pause', 'check']);
});
