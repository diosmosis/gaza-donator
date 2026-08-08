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
| `rankPoolFactor` | 3 | candidates verified per slot before the final ranking |
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

The one exception is the `config` command, which is dispatched *before* the configuration is loaded
and so before it is validated. Otherwise a value that fails validation would lock the user out of
the only command that can repair it. `config` cannot spend money: `config edit` opens the file in
`$VISUAL`/`$EDITOR` (writing the defaults first if there is none), then validates what came back and
offers to re-open if it will not run; `config show` prints the effective configuration together with
any validation error; `config path` prints the path.

## Recipients

Recipients must all be **Gaza Verified**, and among those, the people who received the least in the
last recurrence period are chosen first.

Three cheap API calls (`https://gaza.onl/api/v1/openapi.json`) rank the whole field, before any page
is opened:

1. `GET /api/v1/accounts?hide_inactive=true` — the roster. Each account carries `fqn`, `state`,
   `campaign_url`, and, for verified people, a `profile_fields["Gaza Verified"]` link to
   gaza-verified.org. **The presence of that field is the Gaza Verified filter.** Some instances
   serve that field as rendered HTML, so the anchor is unwrapped rather than read as a URL — ten
   current accounts are listed that way.
2. `GET /api/v1/campaigns/accounts?group_by=account.url&start_time=<window>&sort=amount&hide_inactive=true`
   — how much each account received inside the current window, ascending. **This single call is the
   primary ranking.**
3. The same call **without** `start_time` — everything the API has on record per account. This is
   the secondary key.

The results are joined on `account.url`.

### Filters

A candidate is dropped, with the reason reported in the plan output, when it has no campaign link,
is on an unsupported platform, is not listed as Gaza Verified, is in an excluded account state, is
disabled, is in `excludeAccounts`, or has already been paid successfully this period.

### Ordering

1. **Received in the window**, ascending — the rule from the brief.
2. **Received in total**, ascending — most candidates tie at $0 over a short window, so among the
   people the crowd missed this week, prefer the ones it has been missing all along.
3. **Most recently active**, descending — money should not flow into campaigns whose owner stopped
   posting months ago.
4. **Account URL**, for a deterministic order.

Timestamps from the API carry no timezone and must be read as UTC (`src/time.js`); read as local
time they produce campaigns that were last active "in 4 hours".

### Two totals, and why selection is two-stage

There are two different "total raised" figures and they disagree, by several times, in both
directions:

| account | API lifetime | campaign page |
| --- | --- | --- |
| @Hamed1987 | $638 | $3,271 |
| @Sharif2027 | $13,591 | $6,600 |
| @braa | $233 | $174 |

The API counts only the donations gaza.onl has observed; the page reports the campaign's own
lifetime figure. The page total is the truer number, but it exists only once a campaign page has
been scraped, and scraping all ~220 candidates per run is not viable.

So selection runs in two stages:

1. Rank the whole field on the API's numbers, and verify down that order until a shortlist of
   `slots * rankPoolFactor` candidates has passed. Verification scrapes each campaign page, which is
   where its own raised total comes from.
2. Re-rank that shortlist on the page totals now known — same keys, better numbers — and take
   `slots`.

A candidate whose page total could not be read keeps its API total rather than being treated as $0,
which would put whoever is least known about at the front of the queue.

### Currencies

Campaigns run in their own currencies, so page totals are converted into `currency` before anything
compares them. Establishing the currency differs by platform:

- **GoFundMe** writes the symbol into the progress line ("€6,909 raised of €20,000") and spells out
  the other dollars (`CA$`, `A$`, `MX$`), so a bare `$` means USD.
- **Chuffed** renders *every* currency as a bare `$` — one campaign showing "$942" is AUD while
  another showing "$3,640" is USD, and nothing in the rendered page distinguishes them. The only
  statement of it that reaches the browser is the GraphQL response behind the page, so `inspect`
  listens for that traffic and reads `"currency"` out of it.

Rates come from `frankfurter.dev` (ECB), falling back to `open.er-api.com`, cached for 12 hours and
fetched once per run — lazily, so a fully cached run fetches nothing. A total whose currency cannot
be established, or that cannot be converted, is **not ranked on**: it is reported as a warning and
the candidate falls back to its API total, because ranking on an unknown unit is worse than not
ranking on it.

Conversion decides an order and nothing else. What gets paid is `donationAmount` in `currency`, and
what the card is charged is the platform's own arithmetic.

Chuffed's raised figure also animates upwards from zero, so a single read returns whatever it was
passing through — $2,297 on a campaign that has raised $3,640. It is polled until it stops moving.

`rankPoolFactor` is the cost dial. 1 verifies only what is needed and leaves the API's ordering in
charge; the default of 3 verifies three campaigns per slot. Verification is cached for 15 minutes.

### Slots

`slots = min(floor(remainingBudget / (donationAmount + tipAmount)), maxRecipients)`, where
`remainingBudget = totalAmount - spentThisWindow` from the ledger, further capped by `--limit`.

Candidates are verified lazily, in rank order, only as far down the list as the shortlist needs;
a candidate that fails verification does not consume a shortlist place, so the next one is pulled in.

## Verification

Data from the API is checked against the web before any money moves. Three checks, all cached for
15 minutes:

| check | source | effect |
| --- | --- | --- |
| campaign is live and accepting | the campaign page, in a headless browser | failure drops the candidate |
| Gaza Verified listing | `gaza-verified.org/people/@user@instance/` | must exist and be about this account; if it *also* publishes a campaign link, that link must be the campaign the API reported |
| raised total | scraped from the campaign page | never blocks — but it is what the shortlist is finally ranked on |

Two details that the naive versions of these checks get wrong:

- gaza-verified.org profile pages frequently list only the Mastodon account and no fundraiser link.
  Requiring a matching campaign link therefore rejects genuinely verified people. "Page exists and
  is about this account" is the verification; a **different** campaign is a failure (a possible
  hijacked link), and no campaign at all is a warning.
- The scraped raised total is a lifetime figure while the API total is windowed, so they
  legitimately differ. This can only warn, never block — but it is the number the shortlist is
  finally ranked on, so a failed scrape falls back to the API total rather than to zero.

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
| API + verification cache | `~/.cache/palestine-donator/` | 15 minute TTL; exchange rates 12 hours |

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
bin/donate.js             CLI: plan | donate | card | config | history
src/config.js             defaults <- file <- flags, validation, recurrence window
src/editor.js             locating and running $VISUAL/$EDITOR for `config edit`
src/paths.js              where config, cache, data and the browser profile live
src/cache.js              15-minute TTL disk cache, sha256 keys over sorted params
src/money.js              reading an amount *and its currency* off a page
src/fx.js                 exchange rates, so totals can be ordered against each other
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

162 tests, no network and no browser: selection and both ranking stages, currency parsing and
conversion, budget arithmetic over the ledger
including tips, the misconfigured-budget hard stop, config loading and editor resolution, card
encryption, cache behaviour, API query construction against captured fixtures, the Gaza Verified
check against real captured pages, the drivers' pure helpers, and the payment loop's retry and abort
rules driven through a fake browser.

The browser paths are verified by running `plan` against the live sites.
