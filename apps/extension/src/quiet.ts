/**
 * Shift+Tab asks carat for a minute without offers. Nothing is sent to the
 * worker while the minute runs, the status line counts it down, and
 * Alt+Shift+C ends it early: asking for a suggestion is the plainest way of
 * saying you want one again.
 */

/** How long Shift+Tab buys. */
export const QUIET_MS = 60_000;
/** How often the countdown is handed to the status line. */
export const QUIET_TICK_MS = 1000;

export interface Quiet {
  /** Start the minute, or start it over. */
  start(): void;
  /** End it now, because the user asked for something. */
  end(): void;
  /** Milliseconds left, or null when carat is not in a quiet period. */
  left(): number | null;
  /** Whether carat should keep out of the way. */
  readonly active: boolean;
  /** The page is going: drop the ticker without touching the status line. */
  destroy(): void;
}

/**
 * `report` is handed the milliseconds left on every tick and null when the
 * minute ends, which is exactly what the status line's `setQuiet` wants.
 */
export function createQuiet(report: (left: number | null) => void): Quiet {
  let until = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;

  function left(): number | null {
    const ms = until - Date.now();
    return ms > 0 ? ms : null;
  }

  function stop(): void {
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
  }

  function end(): void {
    if (until === 0) return;
    until = 0;
    stop();
    report(null);
  }

  return {
    start() {
      stop();
      until = Date.now() + QUIET_MS;
      report(QUIET_MS);
      ticker = setInterval(() => {
        const ms = left();
        if (ms === null) end();
        else report(ms);
      }, QUIET_TICK_MS);
    },
    end,
    left,
    get active() {
      return left() !== null;
    },
    destroy() {
      until = 0;
      stop();
    },
  };
}
