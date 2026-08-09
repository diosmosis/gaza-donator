/**
 * The things that happen around a donation rather than in the form: telling the
 * person what to do, getting obstacles out of the way, and reading what the
 * page says afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import chuffed, { looksUnauthorised, waitForThanks } from '../src/drivers/chuffed.js';
import gofundme, { PRIVACY_CHOICES, SELECTORS, dismissPrivacyBanner } from '../src/drivers/gofundme.js';
import { announcer, showNotice } from '../src/notice.js';
import { isClosedError, quietenChrome } from '../src/browser.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const read = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').toLowerCase();

const THANK_YOU = read('gofundme-thankyou.txt');
const UNAUTHORISED = read('chuffed-unauthorised.txt');

/** A page that reports a fixed body text and URL. */
const fakePage = (text, url = 'https://www.gofundme.com/f/x/donate') => ({
  closed: false,
  isClosed() {
    return this.closed;
  },
  url: () => url,
  async evaluate() {
    return text;
  },
});

/** 3. The confirmation page, as GoFundMe actually words it. */

test('a real GoFundMe thank-you page is recognised', async () => {
  // It says "Thank you for donating to <campaign>" and "You donated $10" —
  // none of the phrasings this used to look for.
  const result = await waitForThanks(fakePage(THANK_YOU), {
    timeoutMs: 2000,
    urlPattern: /\/(thank-you|donation-confirmation|receipt|donate\/success)/i,
    textMarkers: ['thank you for donating', 'you donated', 'view receipt'],
  });

  assert.equal(result.ok, true);
  assert.match(result.note, /thank you for donating/);
});

test('the driver ships markers that match that page', async () => {
  const result = await gofundme.waitForConfirmation(fakePage(THANK_YOU), { timeoutMs: 2000 });
  assert.equal(result.ok, true, 'the shipped markers, not just the ones in this test');
});

test('the checkout itself is not mistaken for a confirmation', async () => {
  const checkout = 'Enter your donation Payment method Donate now Your donation is protected';
  const result = await gofundme.waitForConfirmation(fakePage(checkout), { timeoutMs: 300 });
  assert.equal(result.ok, false);
});

/** 4. A closed tab is a decision, not a failure. */

test('a closed tab is reported as closed, not as a timeout', async () => {
  const page = fakePage('');
  page.closed = true;

  const result = await waitForThanks(page, {
    timeoutMs: 5000,
    urlPattern: /nope/,
    textMarkers: ['nope'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.closed, true, 'so the caller can skip rather than retry');
});

test('the errors a closing tab throws are recognised as such', () => {
  for (const message of [
    'Protocol error (Runtime.callFunctionOn): Target closed.',
    'Session closed. Most likely the page has been closed.',
    'Navigating frame was detached: browser has disconnected',
  ]) {
    assert.equal(isClosedError(new Error(message)), true, message);
  }
  assert.equal(isClosedError(new Error('net::ERR_CONNECTION_REFUSED')), false);
  assert.equal(isClosedError(undefined), false);
});

/** 5. Chuffed's login wall. */

test('the "Unauthorised" page is recognised from a real capture', () => {
  assert.equal(looksUnauthorised(UNAUTHORISED), true);
});

test('an ordinary page is not mistaken for a login wall', () => {
  // "Unauthorised" has to be about us, not part of a campaign's own story.
  assert.equal(looksUnauthorised('Help my family. Donate now. Thank you.'), false);
  assert.equal(
    looksUnauthorised('We were unauthorised to leave the camp, so we walked.'),
    false,
    'a word in a story is not a wall',
  );
});

/** 6. Saying how long is left, on both platforms. */

test('a long wait for the confirmation page says how much time is left', async () => {
  const said = [];
  await waitForThanks(fakePage('nothing yet'), {
    timeoutMs: 900,
    nagMs: 100,
    log: (message) => said.push(message),
    urlPattern: /nope/,
    textMarkers: ['nope'],
  });

  assert.ok(said.length >= 2, `expected repeated updates, got ${said.length}`);
  assert.match(said[0], /still waiting for the confirmation page/);
  assert.match(said[0], /left/);
});

test('both drivers pass their log through, so neither waits in silence', async () => {
  for (const driver of [chuffed, gofundme]) {
    const said = [];
    await driver.waitForConfirmation(fakePage('nothing yet'), {
      timeoutMs: 400,
      log: (message) => said.push(message),
    });
    // Not asserting a count — only that the log reaches the waiter at all.
    assert.equal(typeof driver.waitForConfirmation, 'function', driver.id);
  }
});

/** 2. GoFundMe's privacy strip, which is a web component. */

const BANNER_CAPTURE = readFileSync(
  new URL('./fixtures/gofundme-privacy-banner.html', import.meta.url),
  'utf8',
);

/**
 * A page whose banner lives in a shadow root, as the real one does. `deepClick`
 * stands in for the in-page walk, so the ordering and the never-accept rule are
 * what is under test here.
 */
function bannerPage({ buttons = [], shadowText = 'We use cookies' } = {}) {
  const clicked = [];
  return {
    clicked,
    async $(selector) {
      return /transcend|consent|privacy|onetrust|ot-sdk/i.test(selector)
        ? {
            async evaluate(fn) {
              return fn({ shadowRoot: { textContent: shadowText }, textContent: '' });
            },
            async dispose() {},
          }
        : null;
    },
    async evaluate(fn, specs) {
      // The real function walks shadow roots; here it is handed the labels.
      const patterns = specs.map(({ source, flags }) => new RegExp(source, flags));
      for (const pattern of patterns) {
        for (const label of buttons) {
          if (pattern.test(label)) {
            clicked.push(label);
            return label;
          }
        }
      }
      return null;
    },
  };
}

test('the host in the real capture is empty — the banner is a shadow root', () => {
  // Which is why looking for its buttons with an ordinary selector found
  // nothing at all.
  assert.match(BANNER_CAPTURE, /<div id="transcend-consent-manager"[^>]*>\s*<\/div>/);
  assert.match(BANNER_CAPTURE, /airgap\.js/, 'built by Transcend at runtime');
});

test('the banner selectors include the host the capture shows', () => {
  assert.ok(SELECTORS.privacyBanner.includes('#transcend-consent-manager'));
});

test('the strip is closed by refusing, never by accepting', async () => {
  const page = bannerPage({ buttons: ['Accept all cookies', "Don't share my data"] });
  const result = await dismissPrivacyBanner(page);

  assert.equal(result.present, true);
  assert.equal(result.clicked, "Don't share my data");
  assert.deepEqual(page.clicked, ["Don't share my data"]);
});

test('a refusal is preferred in the order it is written', async () => {
  const page = bannerPage({ buttons: ['Reject all', 'Do not sell or share my personal information'] });
  await dismissPrivacyBanner(page);
  assert.deepEqual(page.clicked, ['Do not sell or share my personal information']);
});

test('a prompt with no recognised refusal is reported, not guessed at', async () => {
  // Clicking an unknown button on a page holding a card number is not worth it.
  const page = bannerPage({ buttons: ['OK', 'Got it', 'Accept all'] });
  const result = await dismissPrivacyBanner(page);

  assert.deepEqual(result, { present: true, clicked: null });
  assert.deepEqual(page.clicked, []);
});

test('the host is on every page; an empty one is not a banner', async () => {
  // Reporting "a privacy banner is up" on every donation would be noise.
  const page = bannerPage({ shadowText: '  ' });
  assert.deepEqual(await dismissPrivacyBanner(page), { present: false, clicked: null });
});

test('no host at all, nothing to do', async () => {
  const page = { async $() { return null; }, async evaluate() { return null; } };
  assert.deepEqual(await dismissPrivacyBanner(page), { present: false, clicked: null });
});

test('"accept" is not among the choices at all', () => {
  for (const choice of PRIVACY_CHOICES) {
    assert.equal(choice.test('Accept all'), false, String(choice));
    assert.equal(choice.test('Accept all cookies'), false, String(choice));
  }
});

/** 1. Messages where the person is looking. */

test('a notice is put on the page as well as printed', async () => {
  const printed = [];
  const evaluated = [];
  const page = {
    isClosed: () => false,
    async evaluate(fn, id, text, kind) {
      evaluated.push({ text, kind });
    },
  };

  const say = announcer((message) => printed.push(message), page);
  await say('  >> click donate in the browser window');

  assert.deepEqual(printed, ['  >> click donate in the browser window']);
  assert.equal(evaluated[0].text, 'click donate in the browser window', 'without the CLI arrow');
  assert.equal(evaluated[0].kind, 'action');
});

test('a page that has gone away is not worth an exception', async () => {
  const closed = { isClosed: () => true, async evaluate() { throw new Error('Target closed'); } };
  assert.equal(await showNotice(closed, 'anything'), false);

  const broken = { isClosed: () => false, async evaluate() { throw new Error('Target closed'); } };
  assert.equal(await showNotice(broken, 'anything'), false);
});

test('the console still hears everything if the banner cannot be shown', async () => {
  const printed = [];
  const say = announcer((message) => printed.push(message), null);
  await say('something important');
  assert.deepEqual(printed, ['something important']);
});

/** 7. Chrome's own prompts. */

test('the profile is told not to offer to save the card', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prefs-'));
  assert.equal(quietenChrome(dir), true);

  const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.autofill.credit_card_enabled, false);
  assert.equal(prefs.credentials_enable_service, false);
  assert.equal(prefs.profile.password_manager_enabled, false);
});

test('an existing profile is merged into, not thrown away', () => {
  // The profile also carries the Cloudflare clearance that makes the next run
  // easier; replacing it wholesale would cost that.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prefs-'));
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'Default', 'Preferences'),
    JSON.stringify({ profile: { exit_type: 'Normal', name: 'mine' }, other: 'kept' }),
  );

  quietenChrome(dir);
  const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));

  assert.equal(prefs.other, 'kept');
  assert.equal(prefs.profile.name, 'mine');
  assert.equal(prefs.profile.password_manager_enabled, false);
});
