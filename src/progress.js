/**
 * A progress line for the long-running checks.
 *
 * On a terminal it rewrites one line; piped to a file it prints a line every so
 * often instead, so a redirected run leaves a readable log rather than a wall
 * of carriage returns. It writes to stderr, keeping stdout free for output that
 * might be piped somewhere.
 */
/** Erase the current terminal line, so a shorter line does not leave debris. */
const CLEAR = '\u001b[2K';

export class Progress {
  /**
   * @param {object} options
   * @param {number} options.total
   * @param {NodeJS.WritableStream} [options.stream]
   * @param {boolean} [options.tty]      rewrite one line instead of printing many
   * @param {number} [options.everyMs]   how often to print when not a terminal
   * @param {() => number} [options.now] clock, injectable for tests
   */
  constructor({ total, stream = process.stderr, tty = null, everyMs = 15_000, now = Date.now }) {
    this.total = total;
    this.stream = stream;
    this.tty = tty ?? Boolean(stream.isTTY);
    this.everyMs = everyMs;
    this.now = now;
    this.startedAt = now();
    this.done = 0;
    this.problems = 0;
    this.lastPrint = 0;
    this.active = false;
  }

  /** Record one finished item and redraw. */
  tick({ label = '', ok = true } = {}) {
    this.done += 1;
    if (!ok) this.problems += 1;
    this.render(label);
  }

  render(label = '') {
    const line = this.line(label);
    if (this.tty) {
      this.active = true;
      this.stream.write(`\r${CLEAR}${line}`);
      return;
    }
    // Always print the first and the last, so a redirected run shows that it
    // started and that it finished; everything between is on the interval.
    const at = this.now();
    const due = at - this.lastPrint >= this.everyMs;
    if (!due && this.done > 1 && this.done < this.total) return;
    this.lastPrint = at;
    this.stream.write(`${line}\n`);
  }

  /** Clear the line (or print a final one) so later output starts clean. */
  finish() {
    if (this.tty && this.active) this.stream.write(`\r${CLEAR}`);
    else if (!this.tty) this.stream.write(`${this.line('done')}\n`);
    this.active = false;
  }

  line(label = '') {
    const width = String(this.total).length;
    const percent = this.total > 0 ? Math.floor((this.done / this.total) * 100) : 100;
    const parts = [
      `[${String(this.done).padStart(width)}/${this.total}]`,
      `${String(percent).padStart(3)}%`,
      this.problems > 0 ? `${this.problems} problem(s)` : 'no problems',
      this.remaining(),
      label,
    ].filter(Boolean);

    const line = parts.join('  ');
    // Keep it to one terminal row; a wrapped line defeats the carriage return.
    const max = (this.stream.columns ?? 100) - 1;
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }

  /** Rough time left, from the average so far. */
  remaining() {
    if (this.done === 0 || this.done >= this.total) return '';
    const elapsed = this.now() - this.startedAt;
    const left = Math.round((elapsed / this.done) * (this.total - this.done));
    return `~${formatDuration(left)} left`;
  }
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}
