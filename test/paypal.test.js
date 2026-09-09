/**
 * Filling PayPal's guest checkout.
 *
 * The behaviour worth pinning down is the typing. PayPal's fields drop
 * keystrokes — a live run that sent "Test" left "Te" behind and one that sent
 * "10001" left "1000" — and the obvious repair, clearing the field and typing
 * it again, made things strictly worse: the clear landed, the retype did not,
 * and fields that had been partly right ended up empty.
 *
 * None of that raises anything at the time. A half-typed card number is not a
 * visible failure; it is a decline at the bank that nobody can explain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BILLING_COUNTRY,
  FIELDS,
  expiryCandidates,
  fillPayPalGuest,
  setCountry,
  splitName,
} from '../src/drivers/paypal.js';

// `findFirst` asks the page whether an element is visible; these fakes answer
// out of a plain object rather than a real layout.
globalThis.getComputedStyle ??= () => ({ visibility: 'visible', display: 'block' });

/**
 * A form whose fields stop accepting partway through a burst of typing.
 *
 * Faithful to what was actually seen: "Test" arrived as "Te" and "10001" as
 * "1000" — the field takes the first few keystrokes of each burst and ignores
 * the rest, which is what a re-render mid-type looks like from outside. A
 * select-all followed by Backspace really does empty it, which is how clearing
 * can be told apart from topping up.
 */
function lossyForm(selectors, { acceptPerBurst = 6, country = null } = {}) {
  const fields = new Map();
  const log = [];

  const make = (selector) => {
    const state = { selector, value: '', clears: 0, selectAll: false };
    const handle = {
      state,
      async click({ clickCount } = {}) {
        state.selectAll = clickCount === 3;
      },
      async press(key) {
        if (key === 'Backspace' && state.selectAll) {
          state.value = '';
          state.clears += 1;
        }
        state.selectAll = false;
      },
      async focus() {
        state.selectAll = false;
      },
      async type(text) {
        log.push(`type ${selector}`);
        state.value += String(text).slice(0, acceptPerBurst);
      },
      async evaluate(fn) {
        return fn({
          value: state.value,
          checked: false,
          options: [],
          selectedIndex: -1,
          getClientRects: () => [{}],
          setSelectionRange() {},
          getAttribute: () => null,
        });
      },
      dispose: async () => {},
    };
    return { state, handle };
  };

  for (const selector of selectors) fields.set(selector, make(selector));

  // The country selector, when this form has one. `offers` is the list of
  // country codes it will accept.
  const countryState = country
    ? { selector: country.selector, value: country.value, offers: country.offers ?? ['US', 'AU'] }
    : null;
  if (countryState) {
    fields.set(countryState.selector, {
      state: countryState,
      handle: { dispose: async () => {} },
    });
  }

  return {
    log,
    country: () => countryState,
    field: (selector) => fields.get(selector).state,
    async $(selector) {
      return fields.has(selector) ? fields.get(selector).handle : null;
    },
    async $$() {
      return [];
    },
    async $eval(selector, fn, arg) {
      if (countryState && selector === countryState.selector) {
        return fn(
          {
            value: countryState.value,
            options: countryState.offers.map((code) => ({ value: code, text: code })),
            get selectedIndex() {
              return countryState.offers.indexOf(countryState.value);
            },
          },
          arg,
        );
      }
      const entry = fields.get(selector);
      if (!entry) throw new Error(`no element for ${selector}`);
      return fn({ value: entry.state.value }, arg);
    },
    async select(selector, value) {
      if (!countryState || selector !== countryState.selector) return;
      log.push(`country ${value}`);
      countryState.value = value;
      // The whole point: PayPal throws the rest of the form away.
      for (const [key, entry] of fields) {
        if (key !== countryState.selector) entry.state.value = '';
      }
    },
  };
}

const CARD = { number: '4111111111111111', expMonth: 3, expYear: 2030, cvc: '123', name: 'Amina Haddad' };

test('a card number that loses keystrokes is completed rather than abandoned', async () => {
  const page = lossyForm([FIELDS.number[0]]);

  const result = await fillPayPalGuest(page, { card: CARD, donor: null, timeoutMs: 2000 });

  const number = page.field(FIELDS.number[0]);
  assert.equal(number.value, CARD.number, 'every digit of the card eventually landed');
  assert.ok(result.filled.includes('PayPal number'));
  assert.ok(!result.manual.includes('PayPal number'));
});

test('a partly-typed field is not cleared on the way to fixing it', async () => {
  // Clearing is what turned "Te" into "" on the live form. Once the first pass
  // has put something right in the box, nothing may throw it away.
  const page = lossyForm([FIELDS.number[0], FIELDS.postcode[0]], { acceptPerBurst: 2 });

  await fillPayPalGuest(page, {
    card: CARD,
    donor: { name: 'Amina Haddad', postalCode: '10001' },
    timeoutMs: 2000,
  });

  const postcode = page.field(FIELDS.postcode[0]);
  assert.equal(postcode.value, '10001');
  assert.equal(postcode.clears, 1, 'cleared once to start, never again');
});

test('a field that will not take anything is reported rather than left to chance', async () => {
  // Every keystroke lost. The donor has to be told, because the box looks
  // filled from across the room and is not.
  const page = lossyForm([FIELDS.number[0]], { acceptPerBurst: 0 });

  const result = await fillPayPalGuest(page, { card: CARD, donor: null, timeoutMs: 2000 });

  assert.equal(page.field(FIELDS.number[0]).value, '');
  assert.ok(result.manual.includes('PayPal number'), 'named, not silently skipped');
});

test('a page with no guest form at all says so instead of guessing', async () => {
  const result = await fillPayPalGuest(lossyForm([]), { card: CARD, timeoutMs: 300 });

  assert.equal(result.ok, false);
  assert.match(result.note, /guest card form/);
  assert.deepEqual(result.manual, ['the whole PayPal form']);
});

test('expiry is offered in both spellings the field has wanted', () => {
  // Typed as bare digits it silently stayed empty on the live form; with the
  // separator it took. Neither is guessed at.
  assert.deepEqual(expiryCandidates({ expMonth: 3, expYear: 2030 }), ['03/30', '0330']);
  assert.deepEqual(expiryCandidates({ expMonth: 11, expYear: 2027 }), ['11/27', '1127']);
});

test('splitName fills the two name boxes PayPal asks for', () => {
  assert.deepEqual(splitName('Amina Haddad'), { firstName: 'Amina', lastName: 'Haddad' });
  assert.deepEqual(splitName('Jean Luc Picard'), { firstName: 'Jean', lastName: 'Luc Picard' });
  assert.deepEqual(splitName('Prince'), { firstName: 'Prince', lastName: 'Prince' });
  assert.deepEqual(splitName(''), { firstName: '', lastName: '' });
});

test('every field this tool fills can be found by more than its id', () => {
  // PayPal renames ids more often than it changes what a field is for, so each
  // group carries an autocomplete or name fallback behind the id.
  for (const [label, selectors] of Object.entries(FIELDS)) {
    assert.ok(selectors.length >= 2, `${label} has only one way to be found`);
  }
});

test('the country is set to the US before a single field is typed', async () => {
  // This is the ordering that matters: changing the country empties the whole
  // form, so a country set afterwards wipes the card straight back out — and
  // nothing says so, the boxes just go blank again.
  const page = lossyForm([FIELDS.number[0], FIELDS.postcode[0]], {
    country: { selector: 'select#country', value: 'AU' },
  });

  const result = await fillPayPalGuest(page, {
    card: CARD,
    donor: { name: 'Amina Haddad', postalCode: '10001' },
    timeoutMs: 2000,
  });

  assert.equal(page.country().value, 'US');
  assert.equal(page.log[0], 'country US', 'the country move came first of everything');
  assert.ok(!page.log.slice(1).includes('country US'), 'and only once');

  // And the fields it wiped were filled after it, not before.
  assert.equal(page.field(FIELDS.number[0]).value, CARD.number);
  assert.equal(page.field(FIELDS.postcode[0]).value, '10001');
  assert.ok(result.filled.includes('PayPal country AU -> US'));
});

test('a checkout already on the US is left alone rather than reset for nothing', async () => {
  // Re-selecting the same country would still empty the form; there is nothing
  // to gain from that, and a needless reset is a needless re-render.
  const page = lossyForm([FIELDS.number[0]], {
    country: { selector: 'select#country', value: 'US' },
  });

  const result = await fillPayPalGuest(page, { card: CARD, donor: null, timeoutMs: 2000 });

  assert.ok(!page.log.some((entry) => entry.startsWith('country')), 'never touched');
  assert.ok(!result.filled.some((entry) => entry.startsWith('PayPal country')), 'nothing to report');
  assert.equal(page.field(FIELDS.number[0]).value, CARD.number);
});

test('a checkout that does not offer the US is reported, not forced', async () => {
  const page = lossyForm([FIELDS.number[0]], {
    country: { selector: 'select#country', value: 'AU', offers: ['AU', 'NZ'] },
  });

  const result = await fillPayPalGuest(page, { card: CARD, donor: null, timeoutMs: 2000 });

  assert.equal(page.country().value, 'AU', 'left on what it had, which still works');
  assert.ok(result.manual.some((entry) => /does not offer US/.test(entry)));
  assert.equal(page.field(FIELDS.number[0]).value, CARD.number, 'the card still went in');
});

test('a checkout with no country selector at all fills as before', async () => {
  const page = lossyForm([FIELDS.number[0]]);

  const result = await fillPayPalGuest(page, { card: CARD, donor: null, timeoutMs: 2000 });

  assert.equal(result.country.present, false);
  assert.ok(!result.manual.some((entry) => entry.startsWith('PayPal country')));
  assert.equal(page.field(FIELDS.number[0]).value, CARD.number);
});

test('setCountry says what it did without filling anything', async () => {
  const page = lossyForm([FIELDS.number[0]], {
    country: { selector: 'select#country', value: 'AU' },
  });

  assert.deepEqual(await setCountry(page), {
    present: true,
    ok: true,
    changed: true,
    from: 'AU',
  });
  assert.equal(BILLING_COUNTRY, 'US');
});
