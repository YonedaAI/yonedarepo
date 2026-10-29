// Per-viewer shell preferences: dark by default, light when chosen, and a storage that is
// missing or throws never breaks the shell.
import { describe, expect, it } from 'vitest';
import { applyTheme, saveCollapsed, storedCollapsed, storedTheme } from './theme';

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as unknown as Storage;
};
const broken = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
} as unknown as Storage;

describe('shell preferences', () => {
  it('is dark until the viewer picks light, and remembers the sidebar', () => {
    const storage = memory();
    expect(storedTheme(storage)).toBe('dark');
    applyTheme('light', storage);
    expect(storedTheme(storage)).toBe('light');
    applyTheme('dark', storage);
    expect(storedTheme(storage)).toBe('dark');
    expect(storedCollapsed(storage)).toBe(false);
    saveCollapsed(true, storage);
    expect(storedCollapsed(storage)).toBe(true);
  });

  it('falls back when storage refuses', () => {
    expect(storedTheme(broken)).toBe('dark');
    expect(() => applyTheme('light', broken)).not.toThrow();
    expect(storedCollapsed(broken)).toBe(false);
    expect(() => saveCollapsed(true, broken)).not.toThrow();
  });
});
