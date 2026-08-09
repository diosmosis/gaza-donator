/**
 * Putting the payment page in the configured currency, and not crying wolf
 * about challenges that are not in anyone's way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setCurrency as setGofundmeCurrency, currencyLabel } from '../src/drivers/gofundme.js';
import { setCurrency as setChuffedCurrency, setTip as setChuffedTip } from '../src/drivers/chuffed.js';
import { gateIfBlocking } from '../src/gates.js';

// The interaction helpers check visibility through the page's own DOM API.
globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });

// A React-controlled select ignores a value assigned straight to the element,
// so the driver goes through the prototype's setter. Standing in for it here
// keeps that path under test rather than around it.
globalThis.HTMLSelectElement = function HTMLSelectElement() {};
Object.defineProperty(globalThis.HTMLSelectElement.prototype, 'value', {
  configurable: true,
  get() {
    return undefined;
  },
  set(next) {
    Object.defineProperty(this, 'value', {
      value: next,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  },
});

const element = (props) => ({ getClientRects: () => [{}], ...props });

/** An element handle that runs page functions against a stub. */
function handle(stub, { onClick = () => {} } = {}) {
  return {
    async evaluate(fn, arg) {
      return fn(stub, arg);
    },
    async click() {
      onClick();
    },
    async dispose() {},
  };
}

/**
 * A payment page with a currency control: either GoFundMe's button-and-list, or
 * a plain `select` of the kind Chuffed's page might use.
 */
function fakePage({ button = null, options = [], select = null } = {}) {
  const state = { shown: button, picked: null, opened: false };

  return {
    state,
    async $(selector) {
      if (select && selector.startsWith('select')) {
        // A page function assigns to el.value; the assignment has to survive
        // back out here, the way it would in a real document.
        const stub = element({
          tagName: 'SELECT',
          value: select.value,
          options: select.options.map((value) => ({ value, textContent: value })),
          dispatchEvent: () => true,
        });
        return {
          async evaluate(fn, arg) {
            const result = fn(stub, arg);
            if (stub.value !== select.value) {
              select.value = stub.value;
              state.picked = stub.value;
            }
            return result;
          },
          async click() {},
          async dispose() {},
        };
      }
      if (state.shown !== null && selector.startsWith('button')) {
        return handle(element({ tagName: 'BUTTON', textContent: state.shown }), {
          onClick: () => (state.opened = true),
        });
      }
      return null;
    },
    async $$(selector) {
      if (!state.opened || !selector.startsWith('button')) return [];
      return options.map((label) =>
        handle(element({ tagName: 'BUTTON', textContent: label }), {
          onClick: () => {
            state.picked = label;
            state.shown = label.split(/\s+/)[0];
          },
        }),
      );
    },
    frames: () => [],
  };
}

test('a checkout already in the configured currency is left alone', async () => {
  const page = fakePage({ button: 'USD' });
  const result = await setGofundmeCurrency(page, 'USD');

  assert.deepEqual(result, { ok: true, from: 'USD' });
  assert.equal(page.state.opened, false, 'no need to open the list');
});

test('a checkout in another currency is switched', async () => {
  // Typing 10 into a page set to EUR donates €10, not $10.
  const page = fakePage({ button: 'EUR', options: ['USD United States dollar', 'EUR Euro'] });
  const result = await setGofundmeCurrency(page, 'USD');

  assert.equal(result.ok, true);
  assert.equal(result.from, 'EUR');
  assert.equal(page.state.picked, 'USD United States dollar');
});

test('a campaign that does not offer the currency is reported, not fudged', async () => {
  const page = fakePage({ button: 'EUR', options: ['EUR Euro', 'GBP Pound sterling'] });
  const result = await setGofundmeCurrency(page, 'USD');

  assert.equal(result.ok, false);
  assert.match(result.note, /does not offer USD/);
  assert.match(currencyLabel(result, 'USD'), /does not offer USD/);
});

test('the currency step names what it did', () => {
  assert.match(currencyLabel({ ok: true, from: 'EUR' }, 'USD'), /currency EUR -> USD/);
  assert.match(currencyLabel({ ok: true, from: 'USD' }, 'USD'), /already USD/);
});

/**
 * Chuffed's real flow, from its own bundle: a button showing the current code
 * opens a modal with a `select`, and the choice only applies on Save.
 */
function fakeChuffedPage({ shown = null, currencies = null, save = true } = {}) {
  const state = { shown, opened: false, picked: null, saved: false };

  const selectStub = () => {
    const stub = element({
      tagName: 'SELECT',
      value: state.shown ?? '',
      options: (currencies ?? []).map((value) => ({ value, textContent: value })),
      dispatchEvent: () => true,
    });
    return {
      async evaluate(fn, arg) {
        const result = fn(stub, arg);
        if (stub.value !== (state.shown ?? '')) state.picked = stub.value;
        return result;
      },
      async click() {},
      async dispose() {},
    };
  };

  const saveButton = () =>
    handle(element({ tagName: 'BUTTON', textContent: 'Save' }), {
      onClick: () => {
        state.saved = true;
        if (state.picked) state.shown = state.picked;
      },
    });

  return {
    state,
    async $(selector) {
      // Chuffed's button component overwrites the data-test it is given, so a
      // page where Save can only be found by its label is the realistic one.
      if (selector.includes('currency-conversion-save')) {
        return save === 'by-test-id' ? saveButton() : null;
      }
      if (selector.startsWith('select') && state.opened && currencies) return selectStub();
      if (selector.startsWith('button') && state.shown !== null) {
        return handle(element({ tagName: 'BUTTON', textContent: state.shown }), {
          onClick: () => (state.opened = true),
        });
      }
      return null;
    },
    async $$(selector) {
      // clickMatching looks for the button by its label.
      if (!state.opened || !save || !selector.startsWith('button')) return [];
      return [saveButton()];
    },
    frames: () => [],
  };
}

test('a Chuffed page with no currency control says nothing at all', async () => {
  // Most campaigns offer no choice; a line about it every time would be noise,
  // and there is nothing to get wrong.
  assert.equal(await setChuffedCurrency(fakeChuffedPage({}), 'USD'), null);
});

test('a Chuffed page already in the configured currency is left alone', async () => {
  const page = fakeChuffedPage({ shown: 'USD' });
  const result = await setChuffedCurrency(page, 'USD');

  assert.equal(result.ok, true);
  assert.match(result.label, /already USD/);
  assert.equal(page.state.opened, false);
});

test('a Chuffed currency is chosen in the modal and saved', async () => {
  // The choice only takes effect on Save; without it the modal closes having
  // changed nothing. Save is found by its label, because the test id the
  // source gives it never reaches the page.
  const page = fakeChuffedPage({ shown: 'AUD', currencies: ['AUD', 'USD', 'EUR'], save: 'by-test-id' });
  const result = await setChuffedCurrency(page, 'USD');

  assert.equal(result.ok, true, result.label);
  assert.match(result.label, /currency AUD -> USD/);
  assert.equal(page.state.picked, 'USD');
  assert.equal(page.state.saved, true);
});

test('a currency the campaign does not offer is reported, not fudged', async () => {
  const page = fakeChuffedPage({ shown: 'AUD', currencies: ['AUD', 'NZD'] });
  const result = await setChuffedCurrency(page, 'USD');

  assert.equal(result.ok, false);
  assert.match(result.label, /USD is not on offer/);
});

test('a choice that cannot be saved is not reported as made', async () => {
  const page = fakeChuffedPage({ shown: 'AUD', currencies: ['AUD', 'USD'], save: null });
  const result = await setChuffedCurrency(page, 'USD');

  assert.equal(result.ok, false);
  assert.match(result.label, /could not save/);
});

/** The false alarm that started this: a challenge widget that is not blocking. */

const turnstile = [{ url: () => 'https://challenges.cloudflare.com/turnstile/v0/api.js' }];

test('a challenge widget on a page that works is not a gate', async () => {
  // Chuffed's payment page keeps its Turnstile iframe after it has passed, so a
  // browser carrying clearance shows the form *and* the frame. Announcing a
  // challenge there sends someone looking for something that is not there.
  const page = {
    async $() {
      return { dispose: async () => {} };
    },
    frames: () => turnstile,
  };

  assert.equal(await gateIfBlocking(page, ['#amount'], { timeoutMs: 10 }), null);
});

test('a challenge on a page that does not work is a gate', async () => {
  const page = {
    async $() {
      return null;
    },
    frames: () => turnstile,
    async title() {
      return 'Just a moment...';
    },
    async evaluate() {
      return 'Verify you are human';
    },
  };

  const gate = await gateIfBlocking(page, ['#amount'], { timeoutMs: 10 });
  assert.equal(gate.kind, 'cloudflare-turnstile');
});

test('a missing element with no challenge behind it is not a gate either', async () => {
  const page = {
    async $() {
      return null;
    },
    frames: () => [],
    async title() {
      return 'Help my family';
    },
    async evaluate() {
      return 'Thank you for your support';
    },
  };

  assert.equal(await gateIfBlocking(page, ['#amount'], { timeoutMs: 10 }), null);
});

test('Save is pressed by its label when its test id never reaches the page', async () => {
  // Chuffed's button component replaces whatever data-test it is handed with
  // its own "link-button", so looking for the documented id finds nothing.
  const byLabel = fakeChuffedPage({ shown: 'aud', currencies: ['aud', 'usd'], save: 'by-label' });
  const result = await setChuffedCurrency(byLabel, 'USD');

  assert.equal(result.ok, true, result.label);
  assert.equal(byLabel.state.saved, true);
});

test('the currency is read case-insensitively, as the page writes it', async () => {
  // The button renders "aud"; the chips render "AUD".
  const page = fakeChuffedPage({ shown: 'aud' });
  const result = await setChuffedCurrency(page, 'AUD');

  assert.equal(result.ok, true);
  assert.match(result.label, /already AUD/);
});

/** Chuffed's tip: a tier dropdown, an "Other" box, and a hidden charged amount. */

function fakeTipPage({ tiers = ['+$3.00', '+$4.00', '+$5.00', 'Other'], charged = '4.00' } = {}) {
  const state = { tier: '2', typed: null, charged };

  const select = element({
    tagName: 'SELECT',
    value: state.tier,
    options: tiers.map((label, i) => ({ value: String(i + 1), textContent: label })),
    dispatchEvent: () => true,
  });

  return {
    state,
    async $(selector) {
      if (selector.startsWith('select')) {
        return {
          async evaluate(fn, arg) {
            const result = fn(select, arg);
            state.tier = select.value;
            return result;
          },
          async dispose() {},
        };
      }
      // The free box only exists once "Other" is chosen, as on the real page.
      if (selector.includes('optional-donation-custom-input') && state.tier === '4') {
        return {
          async click() {},
          async press() {},
          async type(value) {
            state.typed = value;
            state.charged = Number(value).toFixed(2);
          },
          async evaluate(fn) {
            return fn(element({ tagName: 'INPUT', value: state.typed ?? '' }));
          },
          async dispose() {},
        };
      }
      if (selector.includes('chuffedAmount')) {
        return {
          async evaluate(fn) {
            return fn(element({ tagName: 'INPUT', value: state.charged }));
          },
          async dispose() {},
        };
      }
      return null;
    },
    frames: () => [],
  };
}

test('the tip goes through "Other", because no tier is ever nothing', async () => {
  // Chuffed adds $4.00 to a $10 donation by default, and its tiers are all
  // additions — zero is only reachable through the free box.
  const page = fakeTipPage();
  assert.equal(await setChuffedTip(page, 0), true);

  assert.equal(page.state.tier, '4', 'chose Other');
  assert.equal(page.state.typed, '0');
  assert.equal(page.state.charged, '0.00');
});

test('a tip that is asked for is set to exactly that', async () => {
  const page = fakeTipPage();
  assert.equal(await setChuffedTip(page, 2.5), true);
  assert.equal(page.state.charged, '2.50');
});

test('the tip is checked against what will be charged, not what was typed', async () => {
  // The hidden field is the one that reaches the payment; if the page ignored
  // the box, saying "tip zeroed" would be a lie about money.
  const page = fakeTipPage();
  page.state.charged = '4.00';
  const original = page.$;
  page.$ = async (selector) =>
    selector.includes('chuffedAmount')
      ? {
          async evaluate(fn) {
            return fn({ tagName: 'INPUT', value: '4.00', getClientRects: () => [{}] });
          },
          async dispose() {},
        }
      : original.call(page, selector);

  assert.equal(await setChuffedTip(page, 0), false, 'the page kept its own figure');
});

test('a form with no tip control yet is not a failure to report', async () => {
  // It does not exist until an amount has been entered.
  const page = { async $() { return null; }, frames: () => [] };
  assert.equal(await setChuffedTip(page, 0), false);
});
