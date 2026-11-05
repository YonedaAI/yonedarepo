// Browser-local sign-up watermark shared by early admission and the Admin shell.
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export const SIGNUPS_SEEN_KEY = 'yoneda.admin.signups-seen';
const browserStore = (): Store | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};
/** When this browser last looked at the sign-ups (0: never); storage may be blocked. */
export function readSeen(store: Store | undefined = browserStore()) {
  try {
    const n = Number(store?.getItem(SIGNUPS_SEEN_KEY));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
export function saveSeen(at: number, store: Store | undefined = browserStore()) {
  try {
    store?.setItem(SIGNUPS_SEEN_KEY, String(at));
  } catch {
    // Blocked storage only means the badge counts from the start again.
  }
}
