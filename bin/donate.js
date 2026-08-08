#!/usr/bin/env node
/**
 * palestine-donator — automate recurring donations to Gaza Verified campaigns.
 *
 * Dry run by default: `plan` never opens a payment page, and `donate` only
 * spends money when given --execute.
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  configProblem,
  describeConfig,
  loadConfig,
  recurrenceDays,
  windowStart,
} from '../src/config.js';
import { editorCommand, openEditor } from '../src/editor.js';
import { ensureDir, resolvePaths } from '../src/paths.js';
import { Cache } from '../src/cache.js';
import { CardStore, cardExpired, redactCard, validateCard } from '../src/card.js';
import { Ledger, STATUS, budgetFor, round2 } from '../src/ledger.js';
import { executeDonations, planRun } from '../src/run.js';
import {
  bold,
  dim,
  formatMoney,
  green,
  red,
  renderHistory,
  renderRecipients,
  renderRejections,
  renderSummary,
  yellow,
} from '../src/report.js';
import { ask, askSecret, confirm, isInteractive } from '../src/prompt.js';

const OPTIONS = {
  config: { type: 'string' },
  total: { type: 'string' },
  amount: { type: 'string' },
  tip: { type: 'string' },
  period: { type: 'string' },
  currency: { type: 'string' },
  limit: { type: 'string' },
  yes: { type: 'boolean', default: false },
  execute: { type: 'boolean', default: false },
  'no-cache': { type: 'boolean', default: false },
  'no-verify': { type: 'boolean', default: false },
  'clear-cache': { type: 'boolean', default: false },
  debug: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const USAGE = `
${bold('palestine-donator')} — donate to Gaza Verified campaigns, spreading it across
the people who have received the least lately.

  ${bold('plan')}                 show who would be donated to (default, never pays)
  ${bold('donate')} [--execute]   donate; without --execute it stops at the confirmation
  ${bold('card')} set|status|clear   manage the encrypted card
  ${bold('config')} edit|show|path   edit the config file in $EDITOR, or inspect it
  ${bold('history')}              show past donations

Options
  --config <path>    config file (default: ~/.config/palestine-donator/config.json)
  --total <amount>   budget for one recurrence period
  --amount <amount>  amount per recipient
  --tip <amount>     tip to the fundraising platform per donation (default 0)
  --period <spec>    daily | weekly | monthly | "10d"
  --currency <code>  three letter currency code
  --limit <n>        donate to at most n recipients this run
  --yes              skip the confirmation prompt
  --execute          actually donate (donate command only)
  --no-verify        skip the campaign / Gaza Verified checks (faster, less safe)
  --no-cache         ignore cached API and verification results
  --clear-cache      delete cached results and exit
  --debug            screenshot the page when a donation fails
`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    fail(err.message, { usage: true });
  }

  const { values: flags, positionals } = parsed;
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const [command = 'plan', ...rest] = positionals;

  // Handled before the configuration is loaded, and so before it is validated:
  // a config file that fails validation would otherwise lock the user out of
  // the one command that can fix it. Nothing here can spend money.
  if (command === 'config') {
    return commandConfig({ file: flags.config, action: rest[0] ?? 'edit' });
  }

  const { config, paths } = loadConfig({
    file: flags.config,
    overrides: cleanUndefined({
      totalAmount: numberFlag(flags.total, '--total'),
      donationAmount: numberFlag(flags.amount, '--amount'),
      tipAmount: numberFlag(flags.tip, '--tip'),
      recurrence: flags.period,
      currency: flags.currency?.toUpperCase(),
      debug: flags.debug || undefined,
    }),
  });

  if (flags['clear-cache']) {
    const removed = new Cache({ dir: paths.cacheDir }).clear();
    console.log(`removed ${removed} cached entries from ${paths.cacheDir}`);
    return 0;
  }

  switch (command) {
    case 'plan':
      return commandPlan({ config, paths, flags });
    case 'donate':
      return commandDonate({ config, paths, flags });
    case 'card':
      return commandCard({ paths, action: rest[0] ?? 'status' });
    // `config` is handled above, before the configuration is validated.
    case 'history':
      return commandHistory({ config, paths });
    default:
      fail(`unknown command "${command}"`, { usage: true });
      return 2;
  }
}

/** Shared plan/select step, plus the table. */
async function planAndReport({ config, paths, flags }) {
  const log = (message) => console.log(message);
  const result = await planRun({
    config,
    paths,
    useCache: !flags['no-cache'],
    verify: !flags['no-verify'],
    limit: numberFlag(flags.limit, '--limit', { integer: true }),
    log,
  });

  const periodLabel = `last ${recurrenceDays(config.recurrence)}d`;
  console.log('');
  console.log(
    `${bold('Budget')} ${formatMoney(config.totalAmount, config.currency)} per ${config.recurrence}` +
      ` · already donated this period ${formatMoney(result.budget.spent, config.currency)}` +
      ` · remaining ${formatMoney(result.budget.remaining, config.currency)}`,
  );
  console.log(
    dim(
      `${result.ranked.length} eligible candidate(s); ` +
        `${result.budget.slots} slot(s) at ${formatMoney(config.donationAmount, config.currency)}` +
        (config.tipAmount > 0
          ? ` + ${formatMoney(config.tipAmount, config.currency)} platform tip ` +
            `(${formatMoney(result.budget.perRecipient, config.currency)})`
          : '') +
        ' each' +
        (flags.limit ? `, limited to ${flags.limit}` : ''),
    ),
  );

  console.log('');
  console.log(bold('Recipients'));
  console.log(renderRecipients(result.chosen, { ...config, periodLabel }));

  const warnings = result.chosen.flatMap((candidate) =>
    (candidate.verification?.warnings ?? []).map((warning) => `  ${candidate.fqn}: ${warning}`),
  );
  if (warnings.length > 0) {
    console.log('');
    console.log(yellow('Warnings'));
    console.log(warnings.join('\n'));
  }

  console.log('');
  console.log(bold('Not selected'));
  console.log(renderRejections(result.rejected));

  return result;
}

async function commandPlan({ config, paths, flags }) {
  const result = await planAndReport({ config, paths, flags });
  console.log('');
  console.log(
    dim(
      result.chosen.length > 0
        ? 'Dry run. Run `donate --execute` to actually donate.'
        : 'Nothing to donate right now.',
    ),
  );
  return 0;
}

async function commandDonate({ config, paths, flags }) {
  const result = await planAndReport({ config, paths, flags });

  if (result.chosen.length === 0) {
    console.log('');
    console.log('Nothing to donate: no eligible recipients, or the period budget is used up.');
    return 0;
  }

  // What the card is actually charged: the donations plus any platform tips.
  const total = round2(result.chosen.length * result.budget.perRecipient);
  console.log('');
  const question =
    `Donate ${formatMoney(config.donationAmount, config.currency)} to each of ` +
    `${result.chosen.length} recipient(s)` +
    (config.tipAmount > 0
      ? `, plus ${formatMoney(config.tipAmount, config.currency)} each to the platform`
      : '') +
    `, ${bold(formatMoney(total, config.currency))} in total?`;

  if (!flags.yes) {
    if (!isInteractive()) fail('the confirmation prompt needs a terminal — pass --yes to skip it');
    if (!(await confirm(question))) {
      console.log('Cancelled. Nothing was donated.');
      return 0;
    }
  } else {
    console.log(`${question} ${dim('(--yes)')}`);
  }

  if (!flags.execute) {
    console.log('');
    console.log(
      yellow('Dry run — no payment pages were opened. Re-run with --execute to donate for real.'),
    );
    return 0;
  }

  const card = await unlockCard(paths);
  if (cardExpired(card)) fail(`the stored card expired (${redactCard(card).expiry})`);
  console.log(dim(`using card ${redactCard(card).toString()}`));

  const ledger = new Ledger(paths.ledgerFile);
  const spentBefore = ledger.spentSince(windowStart(config));

  const { results, aborted, reason } = await executeDonations({
    recipients: result.chosen,
    config,
    paths,
    card,
    ledger,
    log: (message) => console.log(message),
  });

  console.log(
    renderSummary(results, {
      currency: config.currency,
      totalAmount: config.totalAmount,
      spentBefore,
    }),
  );

  if (aborted) {
    console.log('');
    console.log(red(`Stopped early: ${reason}`));
    return 1;
  }
  return results.some((entry) => entry.status === STATUS.FAILED) ? 1 : 0;
}

async function commandCard({ paths, action }) {
  const store = new CardStore(paths.cardFile);

  switch (action) {
    case 'status': {
      if (!store.exists()) {
        console.log(`no card stored (${paths.cardFile})`);
        return 0;
      }
      console.log(`card file: ${paths.cardFile}`);
      const card = store.load(await passphraseFor('card passphrase: '));
      const redacted = redactCard(card);
      console.log(`stored card: ${redacted.toString()}  (${redacted.name})`);
      if (cardExpired(card)) console.log(yellow('this card has expired'));
      return 0;
    }

    case 'set': {
      console.log(
        dim(
          'Use a merchant-locked, spend-limited virtual card (privacy.com or similar).\n' +
            'The card is encrypted with your passphrase and stored at\n' +
            `  ${paths.cardFile}\n`,
        ),
      );
      const number = await askSecret('card number: ');
      const expiry = await ask('expiry (MM/YYYY): ');
      const cvc = await askSecret('cvc: ');
      const name = await ask('name on card: ');

      const [month, year] = expiry.split('/').map((part) => Number(part.trim()));
      const card = {
        number: number.replace(/\s+/g, ''),
        expMonth: month,
        expYear: year < 100 ? 2000 + year : year,
        cvc: cvc.trim(),
        name: name.trim(),
      };
      validateCard(card);

      const passphrase = await askSecret('passphrase to encrypt it with: ');
      const again = await askSecret('passphrase again: ');
      if (passphrase !== again) fail('the passphrases do not match');
      if (passphrase.length < 8) fail('use a passphrase of at least 8 characters');

      store.save(card, passphrase);
      console.log(green(`saved ${redactCard(card).toString()} to ${paths.cardFile}`));
      return 0;
    }

    case 'clear':
      console.log(store.clear() ? `removed ${paths.cardFile}` : 'no card was stored');
      return 0;

    default:
      fail(`unknown card action "${action}" (use set, status or clear)`);
      return 2;
  }
}

async function commandConfig({ file, action }) {
  const configFile = file ?? resolvePaths().configFile;

  switch (action) {
    case 'path':
      console.log(configFile);
      return 0;

    case 'show': {
      const exists = fs.existsSync(configFile);
      console.log(`${bold('config file')} ${configFile}${exists ? '' : dim(' (does not exist — showing defaults)')}`);
      // Deliberately unvalidated: showing a broken configuration is the point.
      const { config } = loadConfig({ file: exists ? configFile : undefined, validate: false });
      console.log(JSON.stringify(config, null, 2));

      const problem = exists ? configProblem(configFile) : null;
      console.log('');
      console.log(problem ? red(problem) : green(describeConfig(config)));
      return problem ? 1 : 0;
    }

    case 'edit':
      return editConfig(configFile);

    default:
      fail(`unknown config action "${action}" (use edit, show or path)`);
      return 2;
  }
}

/** Open the config in $EDITOR, then check what came back before walking away. */
async function editConfig(configFile) {
  if (!fs.existsSync(configFile)) {
    ensureDir(path.dirname(configFile));
    fs.writeFileSync(configFile, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    console.log(dim(`created ${configFile} with the defaults`));
  }

  const editor = editorCommand();
  if (!editor) fail(`no editor found — set $EDITOR, or edit ${configFile} directly`);
  if (!isInteractive()) fail(`an editor needs a terminal — edit ${configFile} directly`);

  for (;;) {
    const status = openEditor(editor, configFile);
    if (status !== 0) console.log(yellow(`${editor[0]} exited with status ${status}`));

    const problem = configProblem(configFile);
    if (!problem) {
      const { config } = loadConfig({ file: configFile });
      console.log(green(`saved ${configFile}`));
      console.log(`  ${describeConfig(config)}`);
      return 0;
    }

    // A config that does not validate is not a config: say so now rather than
    // at the start of the next run that wanted to donate.
    console.log('');
    console.log(red(problem));
    console.log('');
    if (!(await confirm('Re-open the editor to fix it?', { defaultYes: true }))) {
      console.log(yellow(`Left ${configFile} as it is. Commands that spend money will refuse to run.`));
      return 1;
    }
  }
}

async function commandHistory({ config, paths }) {
  // --period already fed into config.recurrence, so this is the same window the
  // budget is enforced over.
  const ledger = new Ledger(paths.ledgerFile);
  const since = windowStart(config, new Date());
  const entries = ledger.since(since);

  console.log(`${bold('History')} ${dim(`since ${since.toISOString().slice(0, 10)}`)}`);
  console.log(renderHistory(entries, { currency: config.currency }));

  const budget = budgetFor({
    totalAmount: config.totalAmount,
    donationAmount: config.donationAmount,
    tipAmount: config.tipAmount,
    spent: ledger.spentSince(since),
    maxRecipients: config.maxRecipients,
  });
  console.log('');
  const tipped = entries.some((entry) => Number(entry.tip) > 0);
  console.log(
    `  ${tipped ? 'donated, including platform tips' : 'donated'}: ` +
      `${formatMoney(budget.spent, config.currency)} · ` +
      `remaining in this period: ${formatMoney(budget.remaining, config.currency)}`,
  );
  return 0;
}

async function unlockCard(paths) {
  const store = new CardStore(paths.cardFile);
  if (!store.exists()) fail('no card stored — run `palestine-donator card set` first');
  return store.load(await passphraseFor('card passphrase: '));
}

/** Prompt for the passphrase, unless a scheduled run supplied it. */
async function passphraseFor(prompt) {
  return process.env.PALESTINE_DONATOR_PASSPHRASE ?? (await askSecret(prompt));
}

function numberFlag(value, name, { integer = false } = {}) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    fail(`${name} must be a ${integer ? 'whole ' : ''}number, got "${value}"`);
  }
  return parsed;
}

function cleanUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function fail(message, { usage = false } = {}) {
  console.error(red(`error: ${message}`));
  if (usage) console.error(USAGE);
  process.exit(2);
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(red(`error: ${err.message}`));
  if (process.env.PALESTINE_DONATOR_TRACE) console.error(err.stack);
  process.exitCode = 1;
}
