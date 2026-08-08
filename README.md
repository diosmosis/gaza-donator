# palestine-donator

Automates recurring donations to Gaza Verified Palestinians running Chuffed and GoFundMe campaigns,
spreading a fixed budget across **the people who have received the least money lately** rather than
the ones already at the top of everyone's feed.

Dry run by default. Nothing is ever charged without both an explicit `donate` command and
`--execute`.

## How it picks people

1. `GET gaza.onl/api/v1/accounts` — the roster of accounts, each with its campaign link and, for
   verified people, a `Gaza Verified` profile field pointing at gaza-verified.org.
2. `GET gaza.onl/api/v1/campaigns/accounts?group_by=account.url&start_time=…&sort=amount` — how much
   each account has received inside the current recurrence period, ascending. This *is* the ranking.
3. Everyone without a Gaza Verified listing, without a campaign link, on an unsupported platform, on
   a suspended/limited account, or already paid this period is dropped.
4. Ties (many people sit at $0 over a short window) break towards **recent activity**, so money does
   not flow into campaigns whose owner stopped posting months ago.
5. Candidates are verified in rank order, only as far down as there are slots to fill.

## Verifying before spending

| check | source | effect |
| --- | --- | --- |
| campaign is live | the campaign page itself | failure drops the candidate |
| Gaza Verified listing | `gaza-verified.org/people/@user@instance/` | must exist and be about this account; if it *also* names a campaign, that campaign must be the one the API reported |
| raised total | scraped from the campaign page | advisory only — shown beside the API figure |

gaza-verified.org frequently lists only the Mastodon account and no fundraiser link. That is normal
and is not treated as a failure; it produces a warning saying there was nothing to compare against.

## Setup

```sh
npm install                    # includes Puppeteer's bundled Chrome
node bin/donate.js card set    # store the card, encrypted
```

Use a **merchant-locked, spend-limited virtual card** (privacy.com or similar). The card is
encrypted with AES-256-GCM under a passphrase you choose and stored at
`~/.config/palestine-donator/card.enc`, mode 0600. It is decrypted into memory for the duration of a
run and never written to the ledger, the cache, logs or debug screenshots.

Optional config at `~/.config/palestine-donator/config.json`:

```json
{
  "totalAmount": 200,
  "donationAmount": 10,
  "tipAmount": 0,
  "currency": "USD",
  "recurrence": "weekly",
  "platforms": ["chuffed", "gofundme"],
  "maxRecipients": 25,
  "includeStates": ["ACTIVE"],
  "excludeAccounts": [],
  "donor": {
    "name": "Your Name",
    "email": "you@example.com",
    "postalCode": "10001",
    "anonymous": true
  }
}
```

`totalAmount` is a **per-period cap**: with a weekly recurrence it is the most that will be donated
inside any rolling 7 days, so re-running mid-week tops up other people instead of doubling up.

`tipAmount` is what the fundraising platform itself gets per donation, on top of `donationAmount`.
Both sites ask for one and default it to a nonzero percentage; at the default of `0` the drivers
push it back down to nothing so the whole amount reaches the family. A tip is charged to the same
card, so it counts against `totalAmount` — at `$10 + $1` a `$200` budget funds 18 recipients, not
20.

### The budget must fit inside maxRecipients

If `totalAmount` would pay more people than `maxRecipients` allows, the script refuses to run at
all:

```
error: misconfigured budget: totalAmount $200.00 at $5.00 per recipient would pay up to 40 people,
  but maxRecipients is 25.
  Raise maxRecipients to at least 40, or lower totalAmount to at most $125.00, or raise donationAmount.
```

Otherwise the cap would silently swallow the rest of the budget every run, which is far more likely
to be a typo in an amount than a deliberate choice. **There is no flag that skips this check** —
every command loads its configuration through the same validation, so `plan`, `donate`, `history`
and `card` all stop until the numbers agree.

## Use

```sh
node bin/donate.js plan                      # who would get money, and why
node bin/donate.js donate                    # plan + confirmation prompt, then stops
node bin/donate.js donate --execute          # actually donate
node bin/donate.js donate --execute --limit 1   # one recipient, for a first run
node bin/donate.js history                   # what has been donated this period
```

Useful flags: `--total`, `--amount`, `--tip`, `--period weekly|monthly|10d`, `--limit`, `--yes`,
`--no-verify`, `--no-cache`, `--clear-cache`, `--debug`.

For a scheduled run, set `PALESTINE_DONATOR_PASSPHRASE` and pass `--yes`. The browser step still
needs a display and a person — see below.

## Donating is assisted, not unattended

Chuffed puts its payment page behind a Cloudflare Turnstile challenge, GoFundMe's checkout is
bot-protected, and a virtual card will often trigger a 3-D Secure prompt from the issuer. This tool
does not attempt to defeat any of that.

Instead, `donate --execute` opens a **visible** browser with a persistent profile and, for each
recipient:

1. navigates to the campaign's payment page,
2. fills in the amount, your donor details and the card, and sets the platform tip to `tipAmount`
   (zero by default, so the whole amount reaches the family),
3. prints what it filled and what it could not, then waits while **you** clear any challenge and
   press the site's own donate button,
4. watches for the confirmation page and records the result.

Failures retry twice with a fresh page; three failed recipients in a row stop the run and print the
summary, so a broken card or a blocked session cannot quietly burn through the budget.

## State

| what | where |
| --- | --- |
| config | `~/.config/palestine-donator/config.json` |
| card | `~/.config/palestine-donator/card.enc` |
| ledger | `~/.local/share/palestine-donator/ledger.jsonl` |
| browser profile | `~/.local/share/palestine-donator/browser-profile/` |
| API + verification cache (15 min TTL) | `~/.cache/palestine-donator/` |

Set `PALESTINE_DONATOR_HOME` to put all of it somewhere else. None of it lives in the repo.

## Tests

```sh
npm test
```

123 tests, no network and no browser: selection and ranking, budget arithmetic over the ledger
(including tips), the misconfigured-budget hard stop, card encryption, cache behaviour, API query
construction against captured fixtures, the Gaza Verified check against real captured pages, the
drivers' pure helpers, and the payment loop's retry and abort rules driven through a fake browser.

The browser paths are verified by running against the live sites:

```sh
node bin/donate.js plan --total 40 --amount 10 --period weekly --limit 3
```

## When a site changes

Campaign sites change their markup regularly. Every selector lives in one `SELECTORS` object per
driver — `src/drivers/chuffed.js` and `src/drivers/gofundme.js` — as ordered fallback lists. If a
run reports fields under "fill in yourself" that it used to fill, that object is the thing to fix.
Chuffed's tip field is the likeliest one to need it: its payment page only renders past a Cloudflare
challenge, so those selectors are written from the page's conventions rather than observed. A tip
the driver cannot set with confidence is reported for you to set by hand rather than guessed at.
`--debug` screenshots the page to `~/.local/share/palestine-donator/debug/` when a donation fails.

## Note

Automating these sites is not something they invite, and this tool is for donating your own money
from your own card. Keep the card merchant-locked and spend-limited, and keep a person in the loop —
which the assisted flow requires anyway.
