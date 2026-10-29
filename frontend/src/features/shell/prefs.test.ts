// Per-viewer shell preferences: the theme is System unless the viewer picked Light or Dark;
// System leaves `<html>` without data-theme (CSS follows prefers-color-scheme) and drops the
// stored key; storage that is missing or throws never breaks the shell.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThemePicker } from './ThemePicker';
import {
  applyTheme,
  nextTheme,
  readTheme,
  saveCollapsed,
  storedCollapsed,
  THEME_KEY,
  writeTheme,
} from './theme';

const memory = () => {
  const data = new Map<string, string>();
  return {
    data,
    storage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    } as unknown as Storage,
  };
};
const element = () => ({ dataset: {} as Record<string, string> }) as unknown as HTMLElement;
const broken = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
} as unknown as Storage;

describe('theme', () => {
  it('is System by default: no stored key and no data-theme', () => {
    const { storage, data } = memory();
    const root = element();
    expect(readTheme(storage)).toBe('system');
    data.set(THEME_KEY, 'sepia');
    expect(readTheme(storage)).toBe('system');
    root.dataset.theme = 'dark';
    writeTheme('system', storage, root);
    expect(data.has(THEME_KEY)).toBe(false);
    expect(root.dataset.theme).toBeUndefined();
  });

  it('keeps and applies Light', () => {
    const { storage, data } = memory();
    const root = element();
    writeTheme('light', storage, root);
    expect([data.get(THEME_KEY), root.dataset.theme, readTheme(storage)]).toEqual([
      'light',
      'light',
      'light',
    ]);
  });

  it('keeps and applies Dark', () => {
    const { storage, data } = memory();
    const root = element();
    writeTheme('dark', storage, root);
    expect([data.get(THEME_KEY), root.dataset.theme, readTheme(storage)]).toEqual([
      'dark',
      'dark',
      'dark',
    ]);
    applyTheme('system', root);
    expect(root.dataset.theme).toBeUndefined();
  });

  it('cycles System, Light, Dark', () => {
    expect([nextTheme('system'), nextTheme('light'), nextTheme('dark')]).toEqual([
      'light',
      'dark',
      'system',
    ]);
  });

  it('offers the three choices, the current one checked', () => {
    const html = renderToStaticMarkup(createElement(ThemePicker, { value: 'dark' }));
    expect(html).toContain('<legend>Theme</legend>');
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    const input = (id: string) => html.match(new RegExp(`<input[^>]*value="${id}"[^>]*>`))?.[0];
    expect(input('dark')).toContain('checked');
    expect(input('system')).not.toContain('checked');
    expect(input('light')).not.toContain('checked');
  });

  it('remembers the sidebar, and falls back when storage refuses', () => {
    const { storage } = memory();
    expect(storedCollapsed(storage)).toBe(false);
    saveCollapsed(true, storage);
    expect(storedCollapsed(storage)).toBe(true);
    expect(readTheme(broken)).toBe('system');
    expect(() => writeTheme('light', broken, element())).not.toThrow();
    expect(storedCollapsed(broken)).toBe(false);
    expect(() => saveCollapsed(true, broken)).not.toThrow();
  });
});
