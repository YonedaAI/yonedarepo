// The shell's per-viewer preferences: the color theme (dark unless the viewer picked light)
// and whether the sidebar is collapsed. Kept in this browser only; storage may be missing
// or refuse (a private window), so every read falls back and every write may be lost.

export type Theme = 'dark' | 'light';
const THEME = 'yoneda.theme';
const SIDEBAR = 'yoneda.sidebar';

const store = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

function read(key: string, storage = store()) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string, storage = store()) {
  try {
    storage?.setItem(key, value);
  } catch {
    // A refused write only forgets the choice on the next visit.
  }
}

export const storedTheme = (storage?: Storage): Theme =>
  read(THEME, storage) === 'light' ? 'light' : 'dark';

export function applyTheme(theme: Theme, storage?: Storage) {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
  write(THEME, theme, storage);
}

export const storedCollapsed = (storage?: Storage) => read(SIDEBAR, storage) === 'collapsed';

export const saveCollapsed = (collapsed: boolean, storage?: Storage) =>
  write(SIDEBAR, collapsed ? 'collapsed' : 'open', storage);
