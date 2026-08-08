/**
 * Finding and running the user's terminal editor, for `config edit`.
 */
import { spawnSync } from 'node:child_process';

/** Tried in order when neither $VISUAL nor $EDITOR is set. */
export const FALLBACK_EDITORS = ['sensible-editor', 'nano', 'vim', 'vi'];

/** Is `program` runnable from this shell? */
function onPath(program) {
  return spawnSync('/bin/sh', ['-c', `command -v ${program}`], { stdio: 'ignore' }).status === 0;
}

/**
 * The editor to run, as `[program, ...args]`, or null if there is nothing to
 * run. $VISUAL and $EDITOR routinely carry arguments ("code --wait", "emacs
 * -nw"), so the setting is split rather than treated as a bare program name.
 *
 * @param {object} [env]
 * @param {(program: string) => boolean} [exists] injectable for tests
 */
export function editorCommand(env = process.env, exists = onPath) {
  const configured = (env.VISUAL || env.EDITOR || '').trim();
  if (configured) return configured.split(/\s+/);

  const found = FALLBACK_EDITORS.find((candidate) => exists(candidate));
  return found ? [found] : null;
}

/**
 * Run the editor on `file`, handing it the terminal.
 *
 * @returns {number} the editor's exit status
 */
export function openEditor(command, file) {
  const [program, ...args] = command;
  const result = spawnSync(program, [...args, file], { stdio: 'inherit' });
  if (result.error) throw new Error(`could not start ${program}: ${result.error.message}`);
  return result.status ?? 0;
}
