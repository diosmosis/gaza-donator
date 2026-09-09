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
3. The same call with no time window — everything the API has ever recorded per account. This is the
   secondary key.
4. Everyone without a Gaza Verified listing, without a campaign link, on an unsupported platform, on
   a suspended/limited account, or already paid this period is dropped.
5. The order is: **least received this period**, then **least received in total**, then **most
   recently active** (so money does not flow into campaigns whose owner stopped posting), then
   account URL for repeatability.
6. The top `rankPoolFactor` × slots candidates are verified — which scrapes each campaign page — and
   that shortlist is then re-ranked on the pages' **own** raised totals before the money is assigned.

Step 6 exists because the two totals disagree. The API only counts donations it has observed; the
campaign page shows its own lifetime figure, and the two differ by several times in both directions.
The API total is what can be known about all ~220 candidates cheaply, so it picks the shortlist; the
page total is the truer number, so it decides the final order. Both are shown in the plan table.

`rankPoolFactor` is the cost dial: 3 (the default) verifies three campaigns per slot and gives the
money to the least-funded of them; 1 verifies only what is needed and leaves the API's order in
charge. Verification results are cached for an hour, so re-running is cheap.

That verification is where a run's minutes go — a campaign page per candidate — so `plan` and
`donate` show a progress line while it happens:

```
[4/9]   44%  8 passed over  ~1m20s left  checking @someone@mastodon.social
```

The count is shortlist places **filled**, so a candidate that fails verification is counted as
"passed over" without advancing the bar. On a terminal it is one line, rewritten; redirected to a
file it prints periodically instead. `--no-verify`, or a period whose budget is already spent, opens
no pages and shows no bar.

`cacheTtlMinutes` (default 60) is how long API responses and verification results stay usable —
`--cache-ttl 5` for a run that should look again sooner, `--no-cache` to ignore what is stored. It
also sets the width of the bucket the recurrence window is rounded to, so that two runs inside the
same hour ask the API the same question and share an entry rather than each fetching afresh.

Campaigns do not all run in the same currency — a Chuffed page reading "$942" may be AUD, and plenty
of GoFundMe campaigns are in EUR — so page totals are **converted into `currency` before they are
compared**, using ECB rates (`frankfurter.dev`, falling back to `open.er-api.com`), cached for 12
hours. The table shows the converted figure and names the currency it came from. A total whose
currency cannot be established, or cannot be converted, is not ranked on at all: the candidate falls
back to its API total rather than being ordered on a number that means nothing. Conversion only ever
decides an order — what gets paid is `donationAmount` in `currency`, and the charge is the
platform's own arithmetic.

## Verifying before spending

| check | source | effect |
| --- | --- | --- |
| campaign is live | the campaign page itself | failure drops the candidate |
| Gaza Verified listing | `gaza-verified.org/people/@user@instance/` | must exist and be about this account; if it *also* names a campaign, that campaign must be the one the API reported |
| raised total | scraped from the campaign page | never blocks — but it is the key the shortlist is finally ranked on, and a page total far below the API's earns a warning |

gaza-verified.org frequently lists only the Mastodon account and no fundraiser link. That is normal
and is not treated as a failure; it produces a warning saying there was nothing to compare against.

### "Live" means a one-off donation can actually be made

Two ways a campaign can be unreachable while its page looks entirely healthy — story, totals, donor
list and a donate button all present, and no wording anywhere that says otherwise:

- **Chuffed, donations closed.** The button still links to the same `/pay/campaign/<uuid>` page. Only
  its label ("Donations closed") and its `--disabled` class say the campaign is over, so the button
  is read rather than just followed.
- **GoFundMe, monthly only.** An organiser can set a fundraiser to take subscriptions and nothing
  else. `/donate` then redirects back to the campaign, so the checkout this tool fills never appears;
  the sole tell is that every donate button reads "Donate monthly" instead of "Donate now". A
  campaign offering *both* is fine and is kept.

Both drop the candidate during `plan` with a reason, and `check` files them under `campaign`. Neither
is inferred from an unread page: no button text at all means nothing either way, and the gate and
status checks answer that instead.

## Setup

```sh
npm install                    # includes Puppeteer's bundled Chrome
node bin/donate.js card set    # store the card, encrypted
```

Use a **merchant-locked, spend-limited virtual card** (privacy.com or similar). The card is
encrypted with AES-256-GCM under a passphrase you choose and stored at
`~/.config/palestine-donator/card.enc`, mode 0600. It is decrypted into memory for the duration of a
run and never written to the ledger, the cache, logs or debug screenshots.

Configuration lives at `~/.config/palestine-donator/config.json` and is optional — the defaults are
usable. To edit it:

```sh
node bin/donate.js config edit    # $VISUAL/$EDITOR, creating the file if needed
node bin/donate.js config show    # the effective configuration, and whether it is valid
node bin/donate.js config path    # just the path
```

`config edit` writes the defaults first if there is no file yet, and checks your work when the
editor exits: if what you saved will not run, it says why and offers to re-open. It is also the one
command that still works when the configuration is invalid — otherwise a bad value would lock you
out of the only thing that can fix it.

The file itself:

```json
{
  "totalAmount": 200,
  "donationAmount": 10,
  "tipAmount": 0,
  "currency": "USD",
  "recurrence": "weekly",
  "platforms": ["chuffed", "gofundme"],
  "maxRecipients": 25,
  "rankPoolFactor": 3,
  "cacheTtlMinutes": 60,
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
Both sites ask for one and default it to a nonzero amount — Chuffed suggests **$4.00 on a $10
donation** — and at the default of `0` the drivers push it back down to nothing so the whole amount
reaches the family. On Chuffed that means choosing "Other" from its tier dropdown and entering the
figure, since every tier it offers is an addition; the result is confirmed against the hidden field
that carries what is actually charged. A tip is charged to the same
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
and `card` all stop until the numbers agree. The one exception is the `config` command itself, which
runs before validation so you can repair the file; it cannot spend money.

## Use

```sh
node bin/donate.js plan                      # who would get money, and why
node bin/donate.js donate                    # plan + confirmation prompt, then stops
node bin/donate.js donate --execute          # actually donate
node bin/donate.js donate --execute --limit 1   # one recipient, for a first run
node bin/donate.js history                   # what has been donated this period
node bin/donate.js config edit               # change the settings
node bin/donate.js check                     # is the scraping still working?
node bin/donate.js gates                     # what has been blocking us lately
```

Useful flags: `--total`, `--amount`, `--tip`, `--period weekly|monthly|10d`, `--limit`, `--yes`,
`--no-verify`, `--cache-ttl`, `--no-cache`, `--clear-cache`, `--debug`.

For a scheduled run, set `PALESTINE_DONATOR_PASSPHRASE` and pass `--yes`. The browser step still
needs a display and a person — see below.

## Bot gates

One gate is part of the design: Chuffed's payment page is behind a Cloudflare challenge, which is
the whole reason donating is assisted. Anywhere else — a campaign page during `plan`, the roster
during `check` — a challenge is news, because it looks exactly like a page whose markup changed. A
gated page has no donate button and no raised total either, so without naming it, being blocked gets
misfiled as "the selector rotted" or, worse, as "this campaign is closed", and that person is
quietly passed over.

So every page load is checked for one — a challenge iframe (Cloudflare, hCaptcha, reCAPTCHA,
DataDome, PerimeterX), interstitial wording, or a 401/403/429/503 — and unexpected ones are appended
to `~/.local/share/palestine-donator/gates.jsonl` and called out in the run's summary.

**A challenge only counts when it is actually in the way.** Chuffed's payment page keeps its
Turnstile widget in the DOM after it has passed, so a browser carrying clearance renders the form
*and* still shows the frame. The question asked is never "is there a challenge?" but "is what we
need missing, and is a challenge why?" — otherwise the run announces a gate that is not in front of
you.

```sh
node bin/donate.js gates          # what has been getting in the way, grouped
node bin/donate.js gates clear    # start the record over
```

`check` reports these under their own kind, `blocked`, distinct from `parse` and `campaign` — being
blocked means nothing was learned either way. Gates are logged from the pass whose answer is
reported, so challenges provoked by the crawl's own load do not fill the file.

The detector is deliberately narrow: these pages talk about "security" and "verification" constantly,
so only interstitial wording counts, and a 404 is a dead campaign rather than a gate.

### Gates nobody can clear

Two of them are not puzzles: `rate-limited` and `blocked-status`. Chuffed serves the first as an
ordinary 200 with the donation form replaced by *"We have noticed suspicious activity. Please try
again later."* — no Cloudflare, no challenge widget, nothing to solve.

Everything else in this list is something a person at the keyboard can get past, so the assisted flow
says "clear it and we'll carry on" and waits. Doing that here spent the donor's **entire** timeout —
five silent minutes by default — on a form that was never coming, and then blamed the markup for it.
`isClearable()` separates the two: an unclearable gate is reported at once, the recipient is handed
back, and it goes in the gate log so `gates` shows how often it is happening.

**Not provoking it in the first place** is the more useful half, and there are two measures:

- `check --deep` no longer opens gated payment pages at all (above) — the single biggest source of
  payment-page traffic, removed at no cost.
- Requests are **paced per host**. Concurrency is across the roster, which is fine spread over
  several sites and is not fine aimed at one: a roster that is mostly Chuffed means `--concurrency 4`
  is four simultaneous Chuffed requests for the length of the run. `createPacer` keeps a minimum gap
  (750ms) between *starts* on any one host, so a mixed roster still moves at full speed while a
  single busy site queues.

What is deliberately **not** done: nothing here tries to look like a different visitor. No fresh
profiles per request, no proxy or address rotation, no fingerprint spoofing. Being told "come back
later" is answered by coming back later.

## Donating is assisted, not unattended

Chuffed puts its payment page behind a Cloudflare Turnstile challenge, GoFundMe's checkout is
bot-protected, and a virtual card will often trigger a 3-D Secure prompt from the issuer. This tool
does not attempt to defeat any of that.

Instead, `donate --execute` opens a **visible** browser with a persistent profile and, for each
recipient:

1. navigates to the campaign's payment page,
2. puts the checkout in your configured `currency` if it opened in another one, then fills in the
   amount, your donor details and the card, and sets the platform tip to `tipAmount` (zero by
   default, so the whole amount reaches the family),
3. turns off both mailing-list opt-ins and, if `donor.anonymous` is set, the "show my name" toggle,
4. says what it filled and what it could not — **in the browser window as well as the terminal**,
   since that is where you are looking — then waits while you clear any challenge and press the
   site's own donate button,
5. watches for the confirmation page, saying how long is left while it waits, and records the result.

Things it gets out of your way on the way through: GoFundMe's privacy strip (dismissed by choosing
*not* to share — never by accepting; its buttons live in a shadow root, so they are reached by
walking the tree rather than by a selector), Chrome's own "save this card?" and "save password?" prompts
(turned off in the donation profile), and Chuffed's "Unauthorised" wall, which it waits at while you
log in rather than giving up on that recipient.

**Closing the tab is an answer.** If you close a payment tab, that recipient is skipped rather than
retried: either the donation went through or you decided against this one, and reopening the page
would be wrong in both readings.

When a challenge appears, the run says so, **keeps watching**, and asks:

```
  Chuffed is showing a cloudflare-turnstile challenge — clear it in the browser
  window and the form will be filled in as soon as it appears
  >> press Enter once you are past the challenge:
```

Either ends the wait. Clear the challenge and the form usually fills itself without you touching the
terminal; press Enter and it looks immediately rather than on its next poll. The prompt appears only
when a challenge was actually detected, and only when someone is there to answer it — a scheduled run
just watches the page. Failing both, it waits out `donationTimeoutMs` (5 minutes by default) and
falls back to "fill it in yourself".

Failures retry twice with a fresh page; three failed recipients in a row stop the run and print the
summary, so a broken card or a blocked session cannot quietly burn through the budget.

## State

| what | where |
| --- | --- |
| config | `~/.config/palestine-donator/config.json` |
| card | `~/.config/palestine-donator/card.enc` |
| ledger | `~/.local/share/palestine-donator/ledger.jsonl` |
| bot gate log | `~/.local/share/palestine-donator/gates.jsonl` |
| browser profile | `~/.local/share/palestine-donator/browser-profile/` |
| API + verification cache (`cacheTtlMinutes`, exchange rates 12 h) | `~/.cache/palestine-donator/` |

Set `PALESTINE_DONATOR_HOME` to put all of it somewhere else. None of it lives in the repo.

## Tests

```sh
npm test
```

295 tests, no network and no browser: selection and both ranking stages, currency parsing and
conversion, bot-gate detection and its log, the diagnostic's classification of findings, the browser
session's lifecycle, budget arithmetic over the ledger
(including tips), the misconfigured-budget hard stop, config loading and editor resolution, card
encryption, cache behaviour, API query construction against captured fixtures, the Gaza Verified
check against real captured pages, the drivers' pure helpers, and the payment loop's retry and abort
rules driven through a fake browser.

The browser paths are verified by running against the live sites:

```sh
node bin/donate.js plan --total 40 --amount 10 --period weekly --limit 3
```

## When a site changes

Campaign sites change their markup without warning, and the failure is quiet: a selector stops
matching, a total reads as null, and the ranking silently gets worse. `check` turns that into a list.

```sh
node bin/donate.js check                    # every Gaza Verified campaign page
node bin/donate.js check --deep             # also open each payment page
node bin/donate.js check --json out.json    # full results, for further analysis
```

It walks **every** Gaza Verified member with a campaign link — not just the ones a run would donate
to — opens each campaign page and confirms the things this tool depends on can still be read: the
raised total, the campaign's currency, and the donate link. `--deep` also opens each payment page and
looks for the controls the donation step fills. It is read-only: pages are opened and parsed, nothing
is ever submitted. Expect around ten minutes for the full roster; there is a live progress line with
an estimate, and `--concurrency` (default 4) trades politeness for speed.

Findings are split by who has to act on them:

| kind | meaning |
| --- | --- |
| `parse` | the page loaded but this tool could not read it — **likely a selector to fix** |
| `campaign` | the campaign is gone, closed or unreachable — nothing to fix here |

Two things keep the report trustworthy, both learned from the first full run:

- **A finding has to reproduce, after the crawl is over.** Campaign pages render themselves in the
  browser and slow down badly under a 250-page crawl, so everything that failed is re-checked one at
  a time once the run has finished, and only reported if it fails again. Without this, the first full
  run called 83 perfectly live campaigns "no donate button"; retrying immediately — still under our
  own load — only cleared half of them. Even so, treat the list as *campaigns to look at* rather than
  as proof: a slow page can still slip through both passes.
- **Chuffed's payment page is reported as inconclusive**, not broken — and is no longer opened at
  all. It sits behind a Cloudflare challenge that never clears headless, so `--deep` could only ever
  conclude "inconclusive" there, whatever the markup was doing. Opening it anyway was not free: once
  per campaign across the whole roster is a burst, and Chuffed answers a burst by refusing to serve
  its payment pages for a while (below). The same conclusion is now reported without going and asking
  for it.

Every selector lives in one `SELECTORS` object per driver — `src/drivers/chuffed.js` and
`src/drivers/gofundme.js` — as ordered fallback lists. If a run reports fields under "fill in
yourself" that it used to fill, that object is the thing to fix.

### GoFundMe has two checkouts, and picks one per campaign

Nothing in the URL, and nothing visible on the page, says which one a campaign gets:

| layout | where the payment section is |
| --- | --- |
| `first-party` | all of it in the campaign page, as it always was |
| `payment-elements` | payment method list, personal and card fields, and the donate button served from `payment-elements.gofundme.com` in iframes |

The amount, tip and anonymity controls stay in the page in both. `paymentSurfaces()` works out which
you have and returns each part as a *surface* — a page or a frame, either of which the browser
helpers take — so nothing above it has to care. `findFirstAcross` polls every surface inside one
deadline rather than giving each its own, which would multiply the wait by the number of frames.

This is worth knowing about because of how it failed: `page.$` does not reach into an iframe, so on
the newer checkout every card field read as absent — and "field not found" is exactly what a checkout
that has not rendered yet looks like. There was no error. The run simply filled in the amount and
handed the whole payment form back to the donor. `check --deep` missed it for the same reason, which
is why `driver.form` now names the surfaces to search and a `reveal` step to run first (nothing but
the amount exists until a payment method is chosen, on either checkout).

Two differences on the newer one that cost money rather than time:

- **A "Give once" / "Monthly" toggle.** It opens on "Give once", but being wrong here signs the donor
  up to a recurring charge, so it is read and set rather than assumed.
- **No currency control at all** — it charges in the fundraiser's own currency. That is reported as
  such, and the donation goes on the "check this yourself" list rather than being passed off as a
  currency the run chose.

### Some Chuffed campaigns take PayPal and nothing else

Their pay page looks entirely normal until section 3, "Payment details", which holds a "Pay via
PayPal" button and no card element at all. `paymentOffer()` asks which of the two submit buttons the
page has — `#js-donate-action-stripe` or `#js-donate-action-paypal` — because reaching for the card
fields regardless is actively misleading: `fillStripeCard` finds nothing, all five card fields land
under "fill in yourself", and the donor goes looking for inputs that are not on the page.

It cannot be spotted during `plan`. The campaign page says nothing about gateways (its GraphQL was
checked), and the pay page needs Cloudflare clearance, so the first time a run meets one is always in
the browser.

When one is found the run presses the PayPal button, follows to PayPal's own checkout — same tab
here, but a popup is handled too — and fills what it can into the **guest** card form, the one that
needs no PayPal account. What it does and does not do there:

| | |
| --- | --- |
| sets first | the billing **country**, to `US` |
| fills | email, card number, expiry, CVV, first and last name, postcode |
| leaves blank | phone, street address, city — the tool does not store them, and a plausible guess on a billing address fails at the bank rather than here |
| turns off | "create a PayPal account" (left on, paying also opens an account, with a password and date of birth to match) and the marketing opt-in |
| never touches | "Agree & Pay" |

**The country goes first, and the order is not negotiable.** PayPal picks a country from the
merchant and the visitor's connection — an Australian charity's checkout opens on Australia — and
the rest of the form is built around it: which address lines it asks for, how the postcode is
validated, which dialling code the phone takes. **Changing it empties every other field.** Set after
the card, it wipes the card straight back out, and nothing reports that: the boxes are simply blank
again, indistinguishable from fields that were never filled. So `setCountry()` runs before the first
keystroke, and `test/paypal.test.js` fails if it is moved. A checkout that does not offer `US` is
left on whatever it had and reported, rather than forced.

**PayPal's fields drop keystrokes.** A live run that sent "Test" left "Te", and "10001" left "1000".
Nothing raises at the time — a half-typed card number is a decline at the bank a week later. So every
field is read back after typing, and a short value is **topped up from where it stopped** rather than
cleared and retyped: clearing was tried first and was strictly worse, turning partly-correct fields
into empty ones. A field that still will not take is named for the donor rather than left to chance.

Expiry is offered as both `MM/YY` and `MMYY` — bare digits silently stayed empty, the separated form
took — and the account switch is clicked via its label as well as itself, because clicking the hidden
input reported success and changed nothing.

Chuffed's payment page cannot be opened without clearing a challenge, so its selectors are read out
of the site's own `payment.js` bundle (linked from the page source) rather than guessed at, and
checked in the test suite against `test/fixtures/chuffed-payment.html` — a capture of the rendered
page. A selector that matches nothing there looks exactly like a control the page does not have, so
that fixture is what tells the two apart. To refresh it: open a payment page, clear the challenge,
and copy the `outerHTML` of the form. Stripe's
card fields are deliberately **not** matched by iframe name — that name has changed twice and each
change silently emptied every card field — but by looking for the inputs themselves in any frame
Stripe owns.
Chuffed's tip field is the likeliest one to need it: its payment page only renders past a Cloudflare
challenge, so those selectors are written from the page's conventions rather than observed. A tip
the driver cannot set with confidence is reported for you to set by hand rather than guessed at.
`--debug` screenshots the page to `~/.local/share/palestine-donator/debug/` when a donation fails.

## Note

Automating these sites is not something they invite, and this tool is for donating your own money
from your own card. Keep the card merchant-locked and spend-limited, and keep a person in the loop —
which the assisted flow requires anyway.
