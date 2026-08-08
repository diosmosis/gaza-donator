/** Interactive prompts on stdin/stdout. */
import readline from 'node:readline';

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export class NotInteractiveError extends Error {
  constructor(what) {
    super(
      `"${what.trim()}" needs an interactive terminal. ` +
        'For a scheduled run, pass --yes and set PALESTINE_DONATOR_PASSPHRASE.',
    );
    this.name = 'NotInteractiveError';
  }
}

export async function ask(question, { defaultValue = '' } = {}) {
  if (!isInteractive()) throw new NotInteractiveError(question);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

/** y/N confirmation. Anything but an explicit yes is a no. */
export async function confirm(question, { defaultYes = false } = {}) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${question} ${suffix} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/**
 * Read a line without echoing it. Used for the card passphrase and the card
 * number, so neither ends up on screen or in a scrollback buffer.
 */
export async function askSecret(question) {
  if (!isInteractive()) throw new NotInteractiveError(question);

  process.stdout.write(question);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004': // ^D
            cleanup();
            process.stdout.write('\n');
            resolve(value);
            return;
          case '\u0003': // ^C
            cleanup();
            process.stdout.write('\n');
            reject(new Error('cancelled'));
            return;
          case '\u007f': // backspace
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            if (char >= ' ') value += char;
        }
      }
    };

    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Wait for the user to press Enter (or Ctrl-C). Used between "the form is
 * filled" and "I clicked donate".
 */
export async function waitForEnter(message) {
  if (!isInteractive()) throw new NotInteractiveError(message);
  await ask(message);
}
