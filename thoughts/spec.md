# palestine-donator

A script that donates on a recurring basis to Palestinians in Gaza running GoFundMe or Chuffed
campaigns, spreading a fixed budget across **the people who have received the least money lately**
rather than the ones already at the top of everyone's feed.

This document describes what the tool does and how it is built. `README.md` covers day-to-day use.

## Configuration

Defaults live in `src/config.js`; a JSON file at `~/.config/palestine-donator/config.json` overrides
them, and CLI flags override both. Everything is validated before anything runs.

| key | default | meaning |
| --- | --- | --- |
| `totalAmount` | 200 | ceiling on what may be charged inside one recurrence period |
| `donationAmount` | 10 | what each recipient gets |
| `tipAmount` | 0 | tip to the fundraising platform per donation, charged to the same card |
| `currency` | `USD` | three-letter code, used for the API query and all display |
| `recurrence` | `weekly` | `daily`/`weekly`/`fortnightly`/`monthly`/`quarterly`/`yearly`, `Nd`/`Nw`/`Nm`, or a bare number of days |
| `platforms` | `["chuffed", "gofundme"]` | campaign platforms a recipient may be on |
| `maxRecipients` | 25 | hard cap on recipients per period |
| `includeStates` | `["ACTIVE"]` | home-instance states to consider; `LIMITED` is opt-in |
| `excludeAccounts` | `[]` | account FQNs or campaign URLs never to donate to |
| `verify` | all three `true` | `{campaign, gazaVerified, raisedTotal}` |
| `raisedTotalWarnRatio` | 0.5 | divergence between scraped and API totals that earns a warning |
| `retries` | 2 | retries per recipient before giving up on them |
| `maxConsecutiveFailures` | 3 | consecutive recipient failures that abort the whole run |
| `donationTimeoutMs` | 300000 | how long to wait for the user to finish a donation in the browser |
| `donor` | name/email/postalCode/`anonymous: true` | filled into campaign forms alongside the card |

Card details are **not** configuration — they live encrypted, see below.

### The budget is a per-period cap

`totalAmount` is the most that may be charged inside a rolling window of one recurrence period, not
a lifetime total. Re-running mid-period tops up other people instead of donating twice.

A tip is charged to the same card, so each recipient costs `donationAmount + tipAmount` and the tip
comes out of the same budget: at `$10 + $1`, a `$200` budget funds 18 recipients rather than 20.

### The budget must fit inside `maxRecipients`

If `floor(totalAmount / (donationAmount + tipAmount))` exceeds `maxRecipients`, validation fails and
the run stops with an explanation and the three ways out (raise the cap, lower the total, raise the
donation). Otherwise the cap would silently swallow part of the budget on every run, which is far
more likely to be a typo in an amount than a deliberate choice.

This check has no escape hatch: no flag skips it, and every command — `plan`, `donate`, `history`,
`card` — loads its configuration through the same validation.

## Recipients

Recipients must all be **Gaza Verified**, and among those, the people who received the least in the
last recurrence period are chosen first.

Both facts come from the gaza.onl API (`https://gaza.onl/api/v1/openapi.json`), so selection needs
no scraping at all:

1. `GET /api/v1/accounts?hide_inactive=true` — the roster. Each account carries `fqn`, `state`,
   `campaign_url`, and, for verified people, a `profile_fields["Gaza Verified"]` link to
   gaza-verified.org. **The presence of that field is the Gaza Verified filter.**
2. `GET /api/v1/campaigns/accounts?group_by=account.url&start_time=<window>&sort=amount&hide_inactive=true`
   — how much each account received inside the current window, ascending. **This single call is the
   ranking.**

The two results are joined on `account.url`.

### Filters

A candidate is dropped, with the reason reported in the plan output, when it has no campaign link,
is on an unsupported platform, is not listed as Gaza Verified, is in an excluded account state, is
disabled, is in `excludeAccounts`, or has already been paid successfully this period.

### Ordering

Ascending by amount received in the window. Most candidates tie at $0 over a short window, so ties
break towards **most recent activity** — money should not flow into campaigns whose owner stopped
posting months ago — and then by account URL for a deterministic order.

Timestamps from the API carry no timezone and must be read as UTC (`src/time.js`); read as local
time they produce campaigns that were last active "in 4 hours".

### Slots

`slots = min(floor(remainingBudget / (donationAmount + tipAmount)), maxRecipients)`, where
`remainingBudget = totalAmount - spentThisWindow` from the ledger, further capped by `--limit`.

Candidates are verified lazily, in rank order, only as far down the list as there are slots to fill;
when one fails verification the next is pulled in.

## Verification

Data from the API is checked against the web before any money moves. Three checks, all cached for
15 minutes:

| check | source | effect |
| --- | --- | --- |
| campaign is live and accepting | the campaign page, in a headless browser | failure drops the candidate |
| Gaza Verified listing | `gaza-verified.org/people/@user@instance/` | must exist and be about this account; if it *also* publishes a campaign link, that link must be the campaign the API reported |
| raised total | scraped from the campaign page | advisory only — printed beside the API figure |

Two details that the naive versions of these checks get wrong:

- gaza-verified.org profile pages frequently list only the Mastodon account and no fundraiser link.
  Requiring a matching campaign link therefore rejects genuinely verified people. "Page exists and
  is about this account" is the verification; a **different** campaign is a failure (a possible
  hijacked link), and no campaign at all is a warning.
- The scraped raised total is a lifetime figure while the API total is windowed, so they
  legitimately differ. This can only warn, never block.

## Donating

Fully unattended card submission is not achievable and is not attempted: Chuffed's payment page sits
behind a Cloudflare Turnstile challenge, GoFundMe's checkout is bot-protected, and a virtual card
will often trigger 3-D Secure. **No captcha-solving and no bot-detection evasion is implemented.**

The flow is therefore *assisted*. `donate --execute` opens a visible browser with a persistent
profile and, per recipient:

1. navigates to the campaign's payment page,
2. fills the amount, the donor details and the card, and sets the platform tip to `tipAmount`
   (0 by default, so the whole amount reaches the family),
3. prints what it filled and what it could not, then waits while the user clears any challenge and
   presses the site's own donate button,
4. watches for the confirmation page and records the outcome.

A field the driver cannot set with confidence is reported for the user to fill in rather than
guessed at — this matters most for tips and amounts, where a wrong guess changes what is charged.

Failures retry with a fresh page up to `retries` times. After `maxConsecutiveFailures` recipients
fail in a row the run stops and prints the summary, so a dead card or a blocked session cannot
quietly burn through the budget. Only confirmed donations are recorded as spent.

### Dry run by default

`plan` never opens a payment page. `donate` re-runs the plan, asks for confirmation, and then still
refuses to pay without an explicit `--execute`.

## Storage

| what | where | notes |
| --- | --- | --- |
| config | `~/.config/palestine-donator/config.json` | optional |
| card | `~/.config/palestine-donator/card.enc` | AES-256-GCM under a scrypt-derived passphrase, mode 0600 |
| ledger | `~/.local/share/palestine-donator/ledger.jsonl` | append-only, one line per attempt |
| browser profile | `~/.local/share/palestine-donator/browser-profile/` | so cookie banners and Cloudflare clearance survive between runs |
| debug screenshots | `~/.local/share/palestine-donator/debug/` | `--debug`, written on failure only |
| API + verification cache | `~/.cache/palestine-donator/` | 15 minute TTL |

`PALESTINE_DONATOR_HOME` relocates all of it. None of it lives in the repo.

The card is expected to be a **merchant-locked, spend-limited virtual card** (privacy.com or
similar). It is decrypted into memory for the duration of a run and never reaches the ledger, the
cache, logs or screenshots; everything user-facing goes through a redaction helper that emits
`•••• 1111`.

The ledger records `{at, fqn, campaignUrl, platform, amount, tip, currency, status, note}` with
status `success | failed | skipped | aborted`, and answers both budget questions: what has been
charged in this window, and who has already been paid.

## Technology

Node.js 20+, ESM, no runtime dependency except Puppeteer. Tests use the built-in `node:test`.

```
bin/donate.js             CLI: plan | donate | card set|status|clear | history
src/config.js             defaults <- file <- flags, validation, recurrence window
src/paths.js              where config, cache, data and the browser profile live
src/cache.js              15-minute TTL disk cache, sha256 keys over sorted params
src/api.js                gaza.onl client
src/time.js               zone-less API timestamps, read as UTC
src/select.js             filtering, ranking, lazy verified selection   (pure)
src/verify.js             the three verification checks
src/ledger.js             JSONL ledger, rolling-window spend, budget arithmetic
src/card.js               encrypted card store, validation, redaction
src/browser.js            Puppeteer lifecycle + selector-list interaction helpers
src/drivers/{chuffed,gofundme,stripe,index}.js
src/report.js             tables and summaries
src/url.js                URL normalisation and platform detection
src/prompt.js             confirmation, hidden passphrase entry
src/run.js                plan pipeline and the assisted payment loop
test/                     node:test, with captured API and HTML fixtures
```

Two design points worth keeping:

- **Selectors rot.** Every site-specific selector lives in one `SELECTORS` object per driver, as
  ordered fallback lists, and is the only thing that should need patching when a site changes.
- **The payment loop is injectable.** `executeDonations` takes its browser and driver resolver as
  parameters, so the rules that decide whether money keeps moving are unit-tested rather than left
  to a live run.

Chuffed's payment form is the one part written from the page's conventions rather than observed,
because it does not render past Turnstile in a headless browser.

## Tests

123 tests, no network and no browser: selection and ranking, budget arithmetic over the ledger
including tips, the misconfigured-budget hard stop, card encryption, cache behaviour, API query
construction against captured fixtures, the Gaza Verified check against real captured pages, the
drivers' pure helpers, and the payment loop's retry and abort rules driven through a fake browser.

The browser paths are verified by running `plan` against the live sites.
