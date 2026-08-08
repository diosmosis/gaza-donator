/**
 * The run pipeline shared by `plan` and `donate`:
 *
 *   fetch -> filter -> rank -> verify -> report      (plan)
 *                                     -> confirm -> pay -> summarise  (donate)
 */
import { Cache } from './cache.js';
import { GazaApi, indexStatsByAccount } from './api.js';
import { BrowserSession } from './browser.js';
import { Ledger, STATUS, budgetFor, round2 } from './ledger.js';
import { buildCandidates, selectRecipients } from './select.js';
import { createVerifier } from './verify.js';
import { driverFor } from './drivers/index.js';
import { recurrenceDays, windowStart } from './config.js';
import { formatMoney, dim, yellow } from './report.js';
import { ensureDir } from './paths.js';

/**
 * Everything up to (but not including) spending money.
 *
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.paths
 * @param {boolean} [options.useCache]
 * @param {boolean} [options.verify]
 * @param {number|null} [options.limit] cap the number of recipients (--limit)
 * @param {(message: string) => void} [options.log]
 */
export async function planRun({
  config,
  paths,
  useCache = true,
  verify = true,
  limit = null,
  log = () => {},
  now = new Date(),
}) {
  const cache = new Cache({ dir: paths.cacheDir, read: useCache });
  const api = new GazaApi({ cache });
  const since = windowStart(config, now);
  const periodDays = recurrenceDays(config.recurrence);

  log(dim(`window: donations since ${since.toISOString().slice(0, 10)} (${periodDays} days)`));

  const [accountsResult, statsResult] = await Promise.all([
    api.getAccounts({ hideInactive: true }),
    api.getAccountCampaignStats({ startTime: since, currency: config.currency }),
  ]);
  log(
    dim(
      `accounts: ${accountsResult.data.length} (${accountsResult.cached ? 'cached' : 'fresh'}), ` +
        `donation stats: ${statsResult.cached ? 'cached' : 'fresh'}`,
    ),
  );

  const ledger = new Ledger(paths.ledgerFile);
  const spent = ledger.spentSince(since);
  const budget = budgetFor({
    totalAmount: config.totalAmount,
    donationAmount: config.donationAmount,
    tipAmount: config.tipAmount,
    spent,
    maxRecipients: config.maxRecipients,
  });
  const slots = limit === null ? budget.slots : Math.min(budget.slots, limit);

  const candidates = buildCandidates(accountsResult.data, indexStatsByAccount(statsResult.data));

  // No slots means nothing to verify, so do not pay to start a browser.
  const willVerify = verify && slots > 0;
  const browser =
    willVerify && (config.verify.campaign || config.verify.raisedTotal)
      ? new BrowserSession({ headless: true })
      : null;

  try {
    const verifier = willVerify ? createVerifier({ config, browser, cache, log }) : null;

    const selection = await selectRecipients({
      candidates,
      platforms: config.platforms,
      includeStates: config.includeStates,
      excludeAccounts: config.excludeAccounts,
      alreadyDonated: ledger.recipientsSince(since),
      slots,
      verify: verifier,
    });

    return { ...selection, budget, slots, since, periodDays, ledger, candidates };
  } finally {
    await browser?.close();
  }
}

/**
 * The assisted payment loop.
 *
 * For each recipient: open the campaign in a visible browser, fill in what we
 * can, wait for the user to clear the captcha / 3-D Secure and press the site's
 * own donate button, then confirm and record the result.
 *
 * `browser` and `resolveDriver` are injectable so the retry and abort rules —
 * the logic that decides whether money keeps moving — can be tested without a
 * real browser or a real campaign.
 *
 * @returns {Promise<{results: object[], aborted: boolean, reason?: string}>}
 */
export async function executeDonations({
  recipients,
  config,
  paths,
  card,
  ledger,
  log = () => {},
  browser = null,
  resolveDriver = driverFor,
}) {
  const results = [];
  let consecutiveFailures = 0;

  const session =
    browser ??
    new BrowserSession({
      headless: false,
      userDataDir: paths.browserProfileDir,
      timeoutMs: 60_000,
    });
  if (config.debug) ensureDir(paths.debugDir);

  try {
    for (const [index, recipient] of recipients.entries()) {
      const heading = `[${index + 1}/${recipients.length}] ${recipient.displayName} — ${recipient.campaignUrl}`;
      log('');
      log(heading);
      log(
        dim(
          `  received ${formatMoney(recipient.receivedInPeriod, config.currency)} this period · ` +
            `donating ${formatMoney(config.donationAmount, config.currency)}` +
            (config.tipAmount > 0
              ? ` + ${formatMoney(config.tipAmount, config.currency)} tip to the platform`
              : ''),
        ),
      );

      const driver = resolveDriver(recipient.campaignUrl);
      if (!driver) {
        results.push(record(ledger, recipient, config, STATUS.SKIPPED, 'no driver for this platform'));
        continue;
      }

      const outcome = await donateOnce({
        driver,
        recipient,
        config,
        card,
        browser: session,
        paths,
        log,
      });

      results.push(record(ledger, recipient, config, outcome.status, outcome.note));

      if (outcome.status === STATUS.SUCCESS) {
        consecutiveFailures = 0;
      } else if (outcome.status === STATUS.FAILED) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= config.maxConsecutiveFailures) {
          log(
            yellow(
              `\n${consecutiveFailures} donations failed in a row — stopping so nothing is charged twice.`,
            ),
          );
          return { results, aborted: true, reason: 'too many consecutive failures' };
        }
      }
    }
    return { results, aborted: false };
  } finally {
    await session.close();
  }
}

/** One recipient, with retries. */
async function donateOnce({ driver, recipient, config, card, browser, paths, log }) {
  const attempts = config.retries + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) log(dim(`  retry ${attempt - 1} of ${config.retries}...`));

    const page = await browser.newPage();
    try {
      const prepared = await driver.prepare(page, {
        campaignUrl: recipient.campaignUrl,
        amount: config.donationAmount,
        tip: config.tipAmount ?? 0,
        card,
        donor: config.donor,
        log,
      });

      log(dim(`  filled: ${prepared.filled.join(', ') || 'nothing'}`));
      if (prepared.manual.length > 0) {
        log(yellow(`  fill in yourself: ${prepared.manual.join(', ')}`));
      }
      log(`  >> complete any captcha / 3-D Secure and click donate in the browser window`);
      log(dim(`     (waiting up to ${Math.round(config.donationTimeoutMs / 60000)} minutes)`));

      const confirmation = await driver.waitForConfirmation(page, {
        timeoutMs: config.donationTimeoutMs,
      });

      if (confirmation.ok) {
        log(`  ✓ ${confirmation.note}`);
        return { status: STATUS.SUCCESS, note: confirmation.note };
      }

      log(yellow(`  ✗ ${confirmation.note}`));
      await snapshot(page, paths, recipient, config, attempt);
      if (attempt === attempts) return { status: STATUS.FAILED, note: confirmation.note };
    } catch (err) {
      log(yellow(`  ✗ ${err.message}`));
      await snapshot(page, paths, recipient, config, attempt);
      if (attempt === attempts) return { status: STATUS.FAILED, note: err.message };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return { status: STATUS.FAILED, note: 'exhausted retries' };
}

/** Debug screenshots never contain a filled card: they are taken on failure only. */
async function snapshot(page, paths, recipient, config, attempt) {
  if (!config.debug || page.isClosed()) return;
  const name = `${recipient.fqn.replace(/[^\w.@-]/g, '_')}-${attempt}.png`;
  await page.screenshot({ path: `${paths.debugDir}/${name}`, fullPage: false }).catch(() => {});
}

function record(ledger, recipient, config, status, note) {
  const entry = ledger.record({
    fqn: recipient.fqn,
    campaignUrl: recipient.campaignUrl,
    platform: recipient.platform,
    amount: status === STATUS.SUCCESS ? round2(config.donationAmount) : 0,
    tip: status === STATUS.SUCCESS ? round2(config.tipAmount ?? 0) : 0,
    currency: config.currency,
    status,
    note,
  });
  return { ...entry, fqn: recipient.fqn };
}
