/**
 * Browser lifecycle. Puppeteer itself is stubbed: what matters here is that one
 * session means one browser, however many pages ask for it at once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../src/browser.js';

function fakeBrowser() {
  const browser = {
    closed: false,
    killed: false,
    pages: 0,
    async newPage() {
      this.pages += 1;
      return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, close: async () => {} };
    },
    process: () => ({ exitCode: 0, signalCode: null, kill: () => (browser.killed = true) }),
    async close() {
      this.closed = true;
    },
  };
  return browser;
}

/** A launcher that takes a moment, the way starting Chrome does. */
function slowLauncher(browser) {
  const launcher = async () => {
    launcher.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return browser;
  };
  launcher.calls = 0;
  return launcher;
}

test('pages opened at the same time share one browser', async () => {
  // Each concurrent caller used to find `browser` still unset and start its own
  // Chrome; the extras were never stored, never closed, and kept the CLI alive
  // long after it had printed its report.
  const browser = fakeBrowser();
  const launcher = slowLauncher(browser);
  const session = new BrowserSession({ launcher });

  const pages = await Promise.all([session.newPage(), session.newPage(), session.newPage()]);

  assert.equal(launcher.calls, 1, 'one browser, not three');
  assert.equal(pages.length, 3);
  assert.equal(browser.pages, 3);
});

test('a browser is started once and reused across sequential pages', async () => {
  const launcher = slowLauncher(fakeBrowser());
  const session = new BrowserSession({ launcher });

  await session.newPage();
  await session.newPage();
  assert.equal(launcher.calls, 1);
});

test('closing while a launch is still in flight does not orphan the browser', async () => {
  const browser = fakeBrowser();
  const session = new BrowserSession({ launcher: slowLauncher(browser) });

  const opening = session.newPage();
  await session.close();
  await opening.catch(() => {});

  assert.equal(browser.closed, true);
});

test('a failed launch does not poison the session', async () => {
  let attempt = 0;
  const browser = fakeBrowser();
  const session = new BrowserSession({
    launcher: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('no chrome here');
      return browser;
    },
  });

  await assert.rejects(() => session.launch(), /no chrome here/);
  assert.equal(await session.launch(), browser, 'a later call may try again');
});

test('closing twice is harmless', async () => {
  const session = new BrowserSession({ launcher: slowLauncher(fakeBrowser()) });
  await session.launch();
  await session.close();
  await session.close();
});

test('a browser that survives close is killed rather than left running', async () => {
  const browser = fakeBrowser();
  browser.process = () => ({ exitCode: null, signalCode: null, kill: () => (browser.killed = true) });
  const session = new BrowserSession({ launcher: slowLauncher(browser) });

  await session.launch();
  await session.close();
  assert.equal(browser.killed, true);
});
