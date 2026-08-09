/**
 * Saying things where they will actually be read.
 *
 * The assisted flow asks a person to do something — clear a challenge, press
 * donate, log in — at a moment when they are looking at a browser window, not
 * at the terminal that launched it. A line printed to a console behind the
 * browser is a line nobody sees, and the run then looks stuck.
 *
 * So the same message goes to both: stdout, and a banner pinned to the top of
 * the page itself.
 */

const ELEMENT_ID = '__palestine_donator_notice';

/**
 * Put a message on the page, replacing whatever was there.
 *
 * Injected rather than styled through a stylesheet so it cannot be affected by
 * the page's own CSS, and marked `pointer-events: none` so it can never sit
 * between the person and a button they need to press.
 *
 * Failures are swallowed: a page that is navigating or already closed is a
 * normal thing to run into here, and a notice is never worth an exception.
 */
export async function showNotice(page, message, { kind = 'info' } = {}) {
  if (!page || page.isClosed?.()) return false;

  try {
    await page.evaluate(
      (id, text, tone) => {
        const colours = {
          info: ['#1f2937', '#f9fafb'],
          action: ['#b45309', '#fffbeb'],
          done: ['#065f46', '#ecfdf5'],
        };
        const [background, foreground] = colours[tone] ?? colours.info;

        let node = document.getElementById(id);
        if (!node) {
          node = document.createElement('div');
          node.id = id;
          document.documentElement.append(node);
        }

        node.style.cssText = [
          'position:fixed',
          'top:0',
          'left:0',
          'right:0',
          'z-index:2147483647',
          'padding:12px 16px',
          'font:600 15px/1.4 system-ui,sans-serif',
          'text-align:center',
          'pointer-events:none',
          'box-shadow:0 2px 12px rgba(0,0,0,.25)',
          `background:${background}`,
          `color:${foreground}`,
        ].join(';');
        node.textContent = text;
      },
      ELEMENT_ID,
      String(message),
      kind,
    );
    return true;
  } catch {
    return false;
  }
}

/** Take the banner down again. */
export async function clearNotice(page) {
  if (!page || page.isClosed?.()) return;
  try {
    await page.evaluate((id) => document.getElementById(id)?.remove(), ELEMENT_ID);
  } catch {
    /* the page went away; nothing to clean up */
  }
}

/**
 * A logger that says everything twice: once to the console, once on the page.
 *
 * @param {(message: string) => void} log
 * @param {import('puppeteer').Page} page
 * @returns {(message: string, options?: {kind?: string, quiet?: boolean}) => Promise<void>}
 */
export function announcer(log, page) {
  return async (message, { kind = 'action', quiet = false } = {}) => {
    if (!quiet) log(message);
    await showNotice(page, message.replace(/^\s*>>\s*/, '').trim(), { kind });
  };
}
