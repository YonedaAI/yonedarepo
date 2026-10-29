// The viewer's color theme and sidebar state, kept in this browser only (there is no account
// preference to keep them in). Theme is System (the default: follows prefers-color-scheme),
// Light or Dark. Contract shared with the public site pages and index.html's first-paint
// script: localStorage `yoneda.theme` is "light" or "dark" for an explicit choice and absent
// for System; `<html data-theme>` carries the explicit choice and is absent for System, so
// CSS follows the operating system. Storage may be missing or refuse (a private window):
// every read falls back and every write may be lost.
import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
export const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];
export const THEME_KEY = 'yoneda.theme';
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

function write(key: string, value: string | null, storage = store()) {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    // A refused write only forgets the choice on the next visit.
  }
}

/** The stored choice; anything but an explicit light or dark is System. */
export function readTheme(storage?: Storage): Theme {
  const stored = read(THEME_KEY, storage);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** Sets `<html data-theme>` for an explicit choice and removes it for System. */
export function applyTheme(theme: Theme, root?: HTMLElement) {
  const element = root ?? (typeof document === 'undefined' ? undefined : document.documentElement);
  if (!element) return;
  if (theme === 'system') delete element.dataset.theme;
  else element.dataset.theme = theme;
}

const listeners = new Set<() => void>();

/** Keeps, applies and announces a choice (every `useTheme` re-renders). */
export function writeTheme(theme: Theme, storage?: Storage, root?: HTMLElement) {
  write(THEME_KEY, theme === 'system' ? null : theme, storage);
  applyTheme(theme, root);
  for (const listener of listeners) listener();
}

/** System → Light → Dark → System. */
export const nextTheme = (theme: Theme): Theme =>
  theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab's choice applies here too.
  const other = (event: StorageEvent) => {
    if (event.key !== THEME_KEY && event.key !== null) return;
    applyTheme(readTheme());
    listener();
  };
  window.addEventListener('storage', other);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', other);
  };
}

/** The current choice and a setter, shared by every control that shows it. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(
    subscribe,
    () => readTheme(),
    () => 'system' as Theme,
  );
  return [theme, (next) => writeTheme(next)];
}

export const storedCollapsed = (storage?: Storage) => read(SIDEBAR, storage) === 'collapsed';

export const saveCollapsed = (collapsed: boolean, storage?: Storage) =>
  write(SIDEBAR, collapsed ? 'collapsed' : 'open', storage);
