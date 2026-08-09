/**
 * The diagnostic behind `check`: walk every Gaza Verified member's campaign and
 * confirm the parts this tool depends on can still be read.
 *
 * Campaign sites change their markup without warning, and the failure mode is
 * quiet: a selector stops matching, a total reads as null, and the ranking
 * silently gets worse. Running this periodically turns that into a list.
 *
 * Nothing here submits anything or opens a payment form in a way that could
 * charge money — it reads pages.
 */
import { driverFor } from './drivers/index.js';
import { findFirst } from './browser.js';

/** What a problem is about, which decides who has to act on it. */
export const KIND = {
  /** The campaign itself: gone, closed, moved. Nothing for us to fix. */
  CAMPAIGN: 'campaign',
  /** We loaded the page but could not read what we need. Probably our selectors. */
  PARSE: 'parse',
  /** Bot protection got in the way; the check learned nothing either way. */
  BLOCKED: 'blocked',
};

/**
 * Check one candidate.
 *
 * @param {object} candidate
 * @param {object} options
 * @param {import('./browser.js').BrowserSession} options.browser
 * @param {(amount: number, from: string) => Promise<number|null>} [options.convert]
 * @param {boolean} [options.deep] also open the payment page and look for its controls
 * @param {(url: string) => object|null} [options.resolveDriver]
 * @returns {Promise<object>} a result record
 */
export async function checkCampaign(
  candidate,
  { browser, convert = null, deep = false, resolveDriver = driverFor },
) {
  const result = {
    fqn: candidate.fqn,
    displayName: candidate.displayName,
    platform: candidate.platform,
    campaignUrl: candidate.campaignUrl,
    problems: [],
    inconclusive: [],
    details: {},
  };
  const problem = (kind, message) => result.problems.push({ kind, message });

  const driver = resolveDriver(candidate.campaignUrl);
  if (!driver) {
    problem(KIND.PARSE, 'no driver for this campaign platform');
    return finish(result);
  }

  let inspection;
  try {
    inspection = await browser.withPage((page) => driver.inspect(page, candidate.campaignUrl));
  } catch (err) {
    problem(KIND.CAMPAIGN, `could not open the campaign page: ${err.message}`);
    return finish(result);
  }

  // A challenge is neither the campaign's fault nor a rotted selector, and
  // filing it as either would send whoever reads this report the wrong way.
  if (inspection.gate) {
    result.gate = inspection.gate;
    problem(KIND.BLOCKED, `bot gate (${inspection.gate.kind}): ${inspection.gate.marker}`);
    return finish(result);
  }

  if (!inspection.ok) {
    problem(KIND.CAMPAIGN, inspection.note ?? 'the campaign page did not check out');
    return finish(result);
  }

  result.details = {
    raisedTotal: inspection.raisedTotal ?? null,
    raisedCurrency: inspection.raisedCurrency ?? null,
    payUrl: inspection.payUrl ?? null,
  };

  // Each of these is something the plan or the payment step relies on.
  if (inspection.raisedTotal === null || inspection.raisedTotal === undefined) {
    problem(KIND.PARSE, 'raised total could not be read from the page');
  }
  if (!inspection.raisedCurrency) {
    problem(KIND.PARSE, 'campaign currency could not be determined');
  } else if (convert) {
    const converted = await convert(inspection.raisedTotal ?? 0, inspection.raisedCurrency);
    if (converted === null) {
      problem(KIND.PARSE, `no exchange rate for ${inspection.raisedCurrency}`);
    } else {
      result.details.converted = Math.round(converted * 100) / 100;
    }
  }
  if (!inspection.payUrl) {
    problem(KIND.PARSE, 'no donate link on the campaign page');
  }

  if (deep && driver.form) {
    await checkForm(result, { driver, browser, campaignUrl: candidate.campaignUrl, inspection });
  }

  return finish(result);
}

/**
 * Open the payment page and look for the controls `prepare` fills.
 *
 * This is the check that matters most — the payment selectors are the ones that
 * cost money when they rot — but it is only conclusive where the page renders
 * without a human. On a gated platform, nothing found means "could not look".
 */
async function checkForm(result, { driver, browser, campaignUrl, inspection }) {
  const url = driver.form.url(campaignUrl, inspection);
  if (!url) {
    result.problems.push({ kind: KIND.PARSE, message: 'no payment page to check' });
    return;
  }

  const entries = Object.entries(driver.form.fields);
  let found;
  try {
    found = await browser.withPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 25_000 }).catch(() => {});

      const present = [];
      for (const [label, selectors] of entries) {
        const handle = await findFirst(page, selectors, { timeoutMs: 3000, visible: false });
        if (handle) {
          present.push(label);
          await handle.dispose();
        }
      }
      return present;
    });
  } catch (err) {
    result.problems.push({ kind: KIND.CAMPAIGN, message: `could not open the payment page: ${err.message}` });
    return;
  }

  const missing = entries.map(([label]) => label).filter((label) => !found.includes(label));
  result.details.formUrl = url;
  result.details.formFound = found;
  result.details.formMissing = missing;

  if (missing.length === 0) return;

  if (driver.form.gated && found.length === 0) {
    result.inconclusive.push(
      'payment form did not render (bot protection); its selectors were not checked',
    );
    return;
  }

  result.problems.push({
    kind: KIND.PARSE,
    message: `payment form is missing: ${missing.join(', ')}`,
  });
}

function finish(result) {
  result.ok = result.problems.length === 0;
  return result;
}

/**
 * Check every candidate, a few at a time, then re-check whatever failed.
 *
 * The second pass runs **after** the crawl rather than immediately, and much
 * more gently. These sites slow down under sustained load — a 250-page crawl
 * makes Chuffed render its donate button too late to be seen — and a retry
 * issued while that load is still on says no more than the first attempt did.
 * Waiting until the end separates "the site was busy" from "the selector is
 * wrong", which is the only distinction this report exists to make.
 *
 * @param {object} options
 * @param {object[]} options.candidates
 * @param {import('./browser.js').BrowserSession} options.browser
 * @param {number} [options.concurrency]
 * @param {boolean} [options.retryFailures]
 * @param {(result: object, index: number) => void} [options.onResult] progress hook
 * @param {(count: number) => void} [options.onRecheck] called before the second pass
 * @param {(ms: number) => Promise<void>} [options.pause] injectable for tests
 * @returns {Promise<object[]>} results in candidate order
 */
export async function checkCampaigns({
  candidates,
  browser,
  concurrency = 4,
  convert = null,
  deep = false,
  resolveDriver = driverFor,
  retryFailures = true,
  gateLog = null,
  onResult = () => {},
  onRecheck = () => {},
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const recordGate = (result) => {
    if (!gateLog || !result?.gate) return;
    gateLog.record({
      stage: 'check',
      fqn: result.fqn,
      platform: result.platform,
      url: result.campaignUrl,
      kind: result.gate.kind,
      marker: result.gate.marker,
    });
  };

  const once = async (candidate) => {
    try {
      return await checkCampaign(candidate, { browser, convert, deep, resolveDriver });
    } catch (err) {
      // A check that throws is itself a finding, not a reason to lose the run.
      return {
        fqn: candidate.fqn,
        platform: candidate.platform,
        campaignUrl: candidate.campaignUrl,
        ok: false,
        problems: [{ kind: KIND.PARSE, message: `the check itself failed: ${err.message}` }],
        inconclusive: [],
        details: {},
      };
    }
  };

  const results = await mapPool(candidates, concurrency, async (candidate, index) => {
    const result = await once(candidate);
    onResult(result, index);
    return result;
  });

  // Gates are logged from the second pass only, so a challenge that was really
  // our own crawl annoying the site does not fill the log.
  const failures = results.map((result, index) => index).filter((index) => !results[index].ok);
  if (!retryFailures || failures.length === 0) {
    for (const index of failures) recordGate(results[index]);
    return results;
  }

  onRecheck(failures.length);
  await pause(3000); // let the sites recover from the crawl before asking again

  // One at a time, however fast the first pass ran: this is the pass whose
  // answer is reported, and there are only ever a handful of campaigns in it.
  await mapPool(failures, 1, async (index) => {
    const second = await once(candidates[index]);
    second.retried = true;
    if (second.ok) second.clearedOnRetry = results[index].problems.map((problem) => problem.message);
    results[index] = second;
    recordGate(second);
    onResult(second, index);
  });

  return results;
}

/** Run `worker` over `items`, at most `limit` at a time, keeping the order. */
export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runner = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return results;
}

/** Group problems by message, worst-represented first. */
export function summarise(results) {
  const groups = new Map();
  for (const result of results) {
    for (const { kind, message } of result.problems) {
      const general = generalise(message);
      const key = `${kind} ${general}`;
      const group = groups.get(key) ?? { kind, message: general, count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.message.localeCompare(b.message),
  );
}

/**
 * Collapse the varying parts of a message so that fifty different campaigns
 * failing the same way count as one line.
 */
function generalise(message) {
  return String(message)
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\d+/g, 'N')
    .trim();
}
