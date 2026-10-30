// The app's type sizes come from theme.css, and none is smaller than the scale allows; the
// public site has its own scale on the same names (site-frame.css).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../../frontend/src/styles/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, dir), 'utf8');
const app = readdirSync(dir).filter((f) => f.endsWith('.css') && !f.startsWith('site'));
const tokens = (css: string) =>
  new Map([...css.matchAll(/--text-([a-z0-9-]+): (\d+)px/g)].map((m) => [m[1], Number(m[2])]));

describe('the app type scale', () => {
  const scale = tokens(read('theme.css'));

  it('meets the sizes the app promises at 100% zoom', () => {
    expect(scale.get('xs')).toBeGreaterThanOrEqual(12);
    expect(scale.get('sm')).toBeGreaterThanOrEqual(13);
    expect(scale.get('md')).toBeGreaterThanOrEqual(14);
    expect(scale.get('base')).toBeGreaterThanOrEqual(15);
    expect(scale.get('mono-dense')).toBeGreaterThanOrEqual(13);
  });

  it('is the only source of small sizes in the app stylesheets', () => {
    const literal =
      /font-size:\s*(\d*\.?\d+)(px|rem|em)|^\s*(\d*\.?\d+)(px|rem)\s*\/\s*[\d.]+\s+"/gm;
    const small = app.flatMap((file) =>
      [...read(file).matchAll(literal)]
        .filter((m) => Number(m[1] ?? m[3]) < 30)
        .map((m) => `${file}: ${m[0].trim()}`),
    );
    expect(small).toEqual([]);
  });

  it('names only sizes the theme defines', () => {
    const used = app.flatMap((file) =>
      [...read(file).matchAll(/var\(--text-([a-z0-9-]+)\)/g)].map((m) => m[1]),
    );
    const defined = new Set([...scale.keys(), 'code', '2']); // --text-2 is a color
    expect(used.filter((name) => !defined.has(name ?? ''))).toEqual([]);
  });

  it('leaves the public site on its own scale', () => {
    expect(tokens(read('site-frame.css')).get('base')).toBe(14);
  });
});
