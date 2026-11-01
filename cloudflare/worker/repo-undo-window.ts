// The undo window's switch (`repo_store/undo.rs` decides, repo-deleted.ts keeps the schedule).
// `REPO_UNDO_DAYS` is its length: unset, empty or 0, a deletion purges at once, as ever. While
// it is set, every command says how long a purge must wait. A value that is not a number means
// the full window: a typo must not turn into purging at once.
type Switch = { REPO_UNDO_DAYS?: string };

export const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;

/** The window in milliseconds; 0 while there is none. */
export function undoMs(env: Switch) {
  const raw = env.REPO_UNDO_DAYS?.trim();
  if (!raw) return 0;
  const days = Number(raw);
  return Math.round((Number.isFinite(days) && days >= 0 ? days : WINDOW_DAYS) * DAY_MS);
}

export const undoOn = (env: Switch) => undoMs(env) > 0;

/** What every command carries while the window is on (never from client input). */
export function undoSwitch(env: Switch) {
  const ms = undoMs(env);
  return ms > 0 ? { _undo_ms: ms } : {};
}
