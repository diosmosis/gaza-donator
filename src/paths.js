/**
 * Where the tool keeps its state. All of it lives outside the repo so a card
 * ciphertext or a ledger can never be committed by accident.
 *
 * Overridable with PALESTINE_DONATOR_HOME (handy for tests and for pointing a
 * cron job at a separate profile).
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const APP = 'palestine-donator';

function xdg(envVar, fallback) {
  const base = process.env[envVar];
  return base && path.isAbsolute(base) ? base : fallback;
}

/** Resolve the state directories, reading the environment at call time. */
export function resolvePaths(env = process.env) {
  const home = env.PALESTINE_DONATOR_HOME;
  const configDir = home
    ? path.join(home, 'config')
    : path.join(xdg('XDG_CONFIG_HOME', path.join(os.homedir(), '.config')), APP);
  const cacheDir = home
    ? path.join(home, 'cache')
    : path.join(xdg('XDG_CACHE_HOME', path.join(os.homedir(), '.cache')), APP);
  const dataDir = home
    ? path.join(home, 'data')
    : path.join(
        xdg('XDG_DATA_HOME', path.join(os.homedir(), '.local', 'share')),
        APP,
      );

  return {
    configDir,
    cacheDir,
    dataDir,
    configFile: path.join(configDir, 'config.json'),
    cardFile: path.join(configDir, 'card.enc'),
    ledgerFile: path.join(dataDir, 'ledger.jsonl'),
    browserProfileDir: path.join(dataDir, 'browser-profile'),
    debugDir: path.join(dataDir, 'debug'),
  };
}

/** mkdir -p, returning the directory for chaining. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
