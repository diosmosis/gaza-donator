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
   * @param {string} [options.problemWord] what a non-ok item is called
   * @param {string} [options.zeroWord]    what to say when there are none
   */
  constructor({
    total,
    stream = process.stderr,
    tty = null,
    everyMs = 15_000,
    now = Date.now,
    problemWord = 'problem(s)',
    zeroWord = 'no problems',
  }) {
    this.total = total;
    this.stream = stream;
    this.tty = tty ?? Boolean(stream.isTTY);
    this.everyMs = everyMs;
    this.now = now;
    this.startedAt = now();
    this.problemWord = problemWord;
    this.zeroWord = zeroWord;
    this.done = 0;
    this.problems = 0;
    this.lastPrint = 0;
    this.printed = false;
    this.active = false;
    this.label = '';
  }

  /** Record one finished item and redraw. */
  tick({ label = '', ok = true } = {}) {
    this.done += 1;
    if (!ok) this.problems += 1;
    this.render(label);
  }

  /**
   * Count something that went wrong without counting it as done.
   *
   * Some work is measured in places filled rather than attempts made — a
   * candidate that fails verification does not fill a slot, and pretending it
   * did would run the bar past the end.
   */
  skip({ label = '' } = {}) {
    this.problems += 1;
    this.render(label);
  }

  /**
   * Print something above the progress line without leaving debris behind it.
   * Anything a run wants to say while the bar is live has to go through here.
   */
  around(write) {
    if (!this.tty || !this.active) {
      write();
      return;
    }
    this.stream.write(`\r${CLEAR}`);
    write();
    this.render(this.label);
  }

  /**
   * Say what is being worked on, without changing the counts.
   *
   * Terminal only: on a redirected run this would be a line per item, which is
   * a log nobody wants when the counts have not moved.
   */
  status(label) {
    if (this.tty) this.render(label);
  }

  render(label = this.label) {
    this.label = label;
    const line = this.line(label);
    if (this.tty) {
      this.active = true;
      this.stream.write(`\r${CLEAR}${line}`);
      return;
    }
    // Always print the first and the last, so a redirected run shows that it
    // started and that it finished; everything between is on the interval.
    // Throttling on time alone: work measured in places filled can leave `done`
    // standing still for a while, and that must not become a line per attempt.
    const at = this.now();
    const due = at - this.lastPrint >= this.everyMs;
    if (this.printed && !due && this.done < this.total) return;
    this.printed = true;
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
      this.problems > 0 ? `${this.problems} ${this.problemWord}` : this.zeroWord,
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
