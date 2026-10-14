type Timers = {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};
const browserTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * Turns a burst of live-update signals into at most one task per interval, plus one trailing run
 * for signals that arrive meanwhile. The task never overlaps itself.
 */
export function coalesceRefresh(
  task: () => Promise<void>,
  intervalMs: number,
  timers: Timers = browserTimers,
) {
  let running = false;
  let pending = false;
  let stopped = false;
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    if (stopped || timer !== undefined) return;
    timer = timers.setTimeout(run, Math.max(0, last + intervalMs - timers.now()));
  }
  async function run() {
    timer = undefined;
    if (stopped) return;
    running = true;
    pending = false;
    last = timers.now();
    try {
      await task();
    } catch {
      // The task reports its own failures; a failed refresh must not stop later signals.
    } finally {
      running = false;
      if (pending) schedule();
    }
  }
  return {
    signal() {
      if (running) pending = true;
      else schedule();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
    },
  };
}
