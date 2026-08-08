import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, extractLinks, normalizeUrl, sameCampaign } from '../src/url.js';

test('normalizeUrl strips the cosmetic differences between sources', () => {
  assert.equal(
    normalizeUrl('https://www.chuffed.org/project/abc'),
    'https://chuffed.org/project/abc',
  );
  assert.equal(normalizeUrl('http://chuffed.org/project/abc/'), 'https://chuffed.org/project/abc');
  assert.equal(
    normalizeUrl('https://chuffed.org/project/abc?utm_source=mastodon#top'),
    'https://chuffed.org/project/abc',
  );
});

test('normalizeUrl rejects things that are not http(s) URLs', () => {
  for (const value of ['', null, undefined, 'not a url', 'mailto:a@b.c', 'javascript:alert(1)']) {
    assert.equal(normalizeUrl(value), null, `expected null for ${value}`);
  }
});

test('normalizeUrl keeps path case, which some slugs depend on', () => {
  assert.notEqual(normalizeUrl('https://chuffed.org/project/Abc'), normalizeUrl('https://chuffed.org/project/abc'));
});

test('sameCampaign matches the API and gaza-verified spellings of one campaign', () => {
  // Exactly the pair seen in the wild: the API says www., gaza-verified.org does not.
  assert.ok(
    sameCampaign(
      'https://www.chuffed.org/project/urgent4mahmoud',
      'https://chuffed.org/project/urgent4mahmoud',
    ),
  );
  assert.ok(!sameCampaign('https://chuffed.org/project/a', 'https://chuffed.org/project/b'));
  assert.ok(!sameCampaign(null, 'https://chuffed.org/project/a'));
});

test('detectPlatform recognises supported hosts only', () => {
  assert.equal(detectPlatform('https://www.chuffed.org/project/x'), 'chuffed');
  assert.equal(detectPlatform('https://chuffed.org/project/x'), 'chuffed');
  assert.equal(detectPlatform('https://www.gofundme.com/f/x'), 'gofundme');
  assert.equal(detectPlatform('https://whydonate.com/fundraising/x'), null);
  assert.equal(detectPlatform('https://example.com/chuffed.org'), null);
  assert.equal(detectPlatform(null), null);
});

test('detectPlatform is not fooled by a lookalike host', () => {
  assert.equal(detectPlatform('https://chuffed.org.evil.com/project/x'), null);
  assert.equal(detectPlatform('https://notgofundme.com/f/x'), null);
});

test('extractLinks handles the quoting styles found in real pages', () => {
  const html = `
    <a href="https://chuffed.org/project/a">one</a>
    <a class="x" href='https://www.gofundme.com/f/b'>two</a>
    <a href=https://example.com/c >three</a>
  `;
  assert.deepEqual(extractLinks(html), [
    'https://chuffed.org/project/a',
    'https://www.gofundme.com/f/b',
    'https://example.com/c',
  ]);
  assert.deepEqual(extractLinks(''), []);
});
