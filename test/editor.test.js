import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_EDITORS, editorCommand } from '../src/editor.js';

const never = () => false;
const always = () => true;

test('$VISUAL wins over $EDITOR, as everywhere else', () => {
  assert.deepEqual(editorCommand({ VISUAL: 'mousepad', EDITOR: 'vi' }, never), ['mousepad']);
  assert.deepEqual(editorCommand({ EDITOR: 'vi' }, never), ['vi']);
});

test('an editor setting may carry arguments', () => {
  assert.deepEqual(editorCommand({ EDITOR: 'code --wait' }, never), ['code', '--wait']);
  assert.deepEqual(editorCommand({ EDITOR: '  emacs -nw  ' }, never), ['emacs', '-nw']);
});

test('with nothing configured, the first installed fallback is used', () => {
  assert.deepEqual(editorCommand({}, always), [FALLBACK_EDITORS[0]]);
  assert.deepEqual(
    editorCommand({}, (program) => program === 'vi'),
    ['vi'],
  );
});

test('no editor at all is reported rather than guessed at', () => {
  assert.equal(editorCommand({}, never), null);
  assert.equal(editorCommand({ VISUAL: '', EDITOR: '   ' }, never), null);
});
