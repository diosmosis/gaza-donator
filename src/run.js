/**
 * The run pipeline shared by `plan` and `donate`:
 *
 *   fetch -> filter -> rank -> verify -> report      (plan)
 *                                     -> confirm -> pay -> summarise  (donate)
 */
import { Cache } from './cache.js';
import { GazaApi, indexStatsByAccount } from './api.js';
import { BrowserSession, isClosedError } from './browser.js';
import { Ledger, STATUS, budgetFor, round2 } from './ledger.js';
import { buildCandidates, selectRecipients } from './select.js';
import { createVerifier } from './verify.js';
import { createConverter } from './fx.js';
import { GateLog } from './gates.js';
import { driverFor } from './drivers/index.js';
import { cacheTtlMs, recurrenceDays, windowStart } from './config.js';
import { formatMoney, dim, yellow } from './report.js';
import { ensureDir } from './paths.js';
import { isInteractive, promptEnter } from './prompt.js';
import { announcer } from './notice.js';

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
  onVerifyStart = () => {},
  onVerifyResult = () => {},
  now = new Date(),
}) {
  const cache = new Cache({ dir: paths.cacheDir, read: useCache, ttlMs: cacheTtlMs(config) });
  const api = new GazaApi({ cache });
  const since = windowStart(config, now);
  const periodDays = recurrenceDays(config.recurrence);

  log(dim(`window: donations since ${since.toISOString().slice(0, 10)} (${periodDays} days)`));

  const [accountsResult, statsResult, lifetimeResult] = await Promise.all([
    api.getAccounts({ hideInactive: true }),
    api.getAccountCampaignStats({ startTime: since, currency: config.currency }),
    // The secondary ranking key: what each account has raised in total.
    api.getAccountLifetimeStats({ currency: config.currency }),
  ]);
  log(
    dim(
      `accounts: ${accountsResult.data.length} (${accountsResult.cached ? 'cached' : 'fresh'}), ` +
        `donation stats: ${statsResult.cached ? 'cached' : 'fresh'}, ` +
        `lifetime totals: ${lifetimeResult.cached ? 'cached' : 'fresh'}`,
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

  const candidates = buildCandidates(
    accountsResult.data,
    indexStatsByAccount(statsResult.data),
    indexStatsByAccount(lifetimeResult.data),
  );

  // No slots means nothing to verify, so do not pay to start a browser.
  const willVerify = verify && slots > 0;
  const browser =
    willVerify && (config.verify.campaign || config.verify.raisedTotal)
      ? new BrowserSession({ headless: true })
      : null;

  try {
    // Campaign totals come back in the campaign's own currency; ranking them
    // against each other means converting them all to the configured one.
    const convert = createConverter({
      base: config.currency,
      cache,
      log: (message) => log(dim(message)),
    });

    // Gates seen during planning go straight to the persistent log, and come
    // back in the result so this run's summary can mention them.
    const gateLog = new GateLog(paths.gatesFile);
    const gates = [];
    const onGate = (gate) => {
      gates.push(gateLog.record(gate));
      log(yellow(`  ${gate.fqn}: bot gate (${gate.kind}) on ${gate.url}`));
    };

    let cachedVerifications = 0;
    const verifier = willVerify
      ? createVerifier({
          config,
          browser,
          cache,
          log,
          convert,
          onGate,
          onCached: () => (cachedVerifications += 1),
        })
      : null;

    const selection = await selectRecipients({
      candidates,
      platforms: config.platforms,
      includeStates: config.includeStates,
      excludeAccounts: config.excludeAccounts,
      alreadyDonated: ledger.recipientsSince(since),
      slots,
      verify: verifier,
      poolFactor: config.rankPoolFactor,
      log: (message) => log(dim(message)),
      onVerifyStart,
      onVerifyResult,
    });

    if (cachedVerifications > 0) {
      log(dim(`${cachedVerifications} verification(s) served from cache`));
    }

    return { ...selection, budget, slots, since, periodDays, ledger, candidates, gates, gateLog };
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
  gateLog = paths?.gatesFile ? new GateLog(paths.gatesFile) : null,
  // Offered only when a challenge is actually in the way, and only to someone
  // who is there to answer it. Whichever happens first — the form appearing or
  // Enter — ends the wait.
  confirmGate = isInteractive()
    ? () => promptEnter('  >> press Enter once you are past the challenge: ')
    : null,
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
        gateLog,
        confirmGate,
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
async function donateOnce({ driver, recipient, config, card, browser, paths, log, gateLog, confirmGate }) {
  const attempts = config.retries + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) log(dim(`  retry ${attempt - 1} of ${config.retries}...`));

    const page = await browser.newPage();
    try {
      // Said before the page opens, not after: on a gated platform this step
      // can sit waiting for minutes, and a silent wait is what made an earlier
      // version look hung.
      log(dim('  opening the payment page — clear any challenge you see and the form fills itself'));

      // Everything from here is said on the page as well as in the terminal:
      // the person is looking at the browser, not at the console behind it.
      const say = announcer(log, page);

      const prepared = await driver.prepare(page, {
        campaignUrl: recipient.campaignUrl,
        amount: config.donationAmount,
        tip: config.tipAmount ?? 0,
        currency: config.currency,
        card,
        donor: config.donor,
        log: (message) => say(message),
        timeoutMs: config.donationTimeoutMs,
        confirmGate,
      });

      log(dim(`  filled: ${prepared.filled.join(', ') || 'nothing'}`));
      if (prepared.manual.length > 0) {
        log(yellow(`  fill in yourself: ${prepared.manual.join(', ')}`));
      }

      // Chuffed's payment page is gated by design and the assisted flow is
      // built around it; anywhere else, a gate is worth writing down.
      if (prepared.gate && !prepared.gateExpected) {
        gateLog?.record({
          stage: 'donate',
          fqn: recipient.fqn,
          platform: recipient.platform,
          url: prepared.url ?? recipient.campaignUrl,
          kind: prepared.gate.kind,
          marker: prepared.gate.marker,
          note: 'on the payment page',
        });
      }
      await say(
        prepared.manual.length > 0
          ? `  >> fill in what is missing, then click donate in the browser window`
          : `  >> click donate in the browser window (and clear 3-D Secure if your bank asks)`,
      );
      log(
        dim(
          `     waiting up to ${Math.round(config.donationTimeoutMs / 60000)} minutes for the ` +
            'confirmation page',
        ),
      );

      const confirmation = await driver.waitForConfirmation(page, {
        timeoutMs: config.donationTimeoutMs,
        log,
      });

      if (confirmation.ok) {
        await say(`  ✓ ${confirmation.note}`, { kind: 'done' });
        return { status: STATUS.SUCCESS, note: confirmation.note };
      }

      // A closed tab is an answer, not a fault: this one is either already done
      // or deliberately abandoned. Either way, retrying it would reopen a
      // payment page for a donation the person has finished with.
      if (confirmation.closed) {
        log(dim('  the tab was closed — taking that as done or deliberately skipped'));
        return { status: STATUS.SKIPPED, note: 'the tab was closed, so this one was left alone' };
      }

      log(yellow(`  ✗ ${confirmation.note}`));
      await snapshot(page, paths, recipient, config, attempt);
      if (attempt === attempts) return { status: STATUS.FAILED, note: confirmation.note };
    } catch (err) {
      if (isClosedError(err) || page.isClosed()) {
        log(dim('  the tab was closed — taking that as done or deliberately skipped'));
        return { status: STATUS.SKIPPED, note: 'the tab was closed, so this one was left alone' };
      }
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
