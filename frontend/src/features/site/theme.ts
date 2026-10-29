// The colour theme: System (default, follows the OS), Light or Dark, kept in this browser and
// applied as `data-theme` on <html> (absent for System). This is the site's stand-in for the
// app shell's theme setting: swap these functions for the shared module when it lands.

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

const KEY = 'yoneda.theme';

// Applied as soon as the site's code loads, before React renders anything.
if (typeof window !== 'undefined') applyTheme(readTheme());

export const nextTheme = (theme: Theme): Theme =>
  THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];

/** The stored choice; storage may be blocked, so System when it cannot be read. */
export function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(KEY);
    return THEMES.find((t) => t === stored) ?? 'system';
  } catch {
    return 'system';
  }
}

/** Stores the choice (best effort) and applies it to the page at once. */
export function writeTheme(theme: Theme) {
  try {
    if (theme === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, theme);
  } catch {
    // The choice still applies to this page; it just is not remembered.
  }
  applyTheme(theme);
}

export function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
