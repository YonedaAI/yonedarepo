// Production build step: short names for the stylesheet's custom properties. Used about 1,700
// times, the long names are an eighth of it, and only the stylesheet reads them. The sources
// and the dev server keep them. A name the JavaScript spells (an inline `--avatar-size`) stays.
import type { Plugin } from 'vite';

const NAME = /(?<![\w-])--[A-Za-z_][\w-]*/g;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** `--a` to `--z`, then `--aa`, `--ab` and on. */
function shortName(index: number) {
  let name = '';
  for (let n = index; n >= 0; n = Math.floor(n / LETTERS.length) - 1)
    name = LETTERS[n % LETTERS.length] + name;
  return `--${name}`;
}

/** `css` with each custom property renamed, the most used shortest, except those in `keep`. */
export function shortenNames(css: string, keep: Set<string>) {
  const uses = new Map<string, number>();
  for (const [name] of css.matchAll(NAME)) uses.set(name, (uses.get(name) ?? 0) + 1);
  const renamed = [...uses.keys()]
    .filter((name) => !keep.has(name))
    .sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0) || a.localeCompare(b));
  const short = new Map<string, string>();
  let next = 0;
  for (const name of renamed) {
    let candidate = shortName(next++);
    while (keep.has(candidate)) candidate = shortName(next++);
    short.set(name, candidate);
  }
  return css.replace(NAME, (name) => short.get(name) ?? name);
}

export function shortCssNames(): Plugin {
  return {
    name: 'yoneda-short-css-names',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.values(bundle);
      const keep = new Set<string>();
      for (const file of files)
        if (file.type === 'chunk') for (const [name] of file.code.matchAll(NAME)) keep.add(name);
      for (const file of files)
        if (file.type === 'asset' && file.fileName.endsWith('.css'))
          file.source = shortenNames(String(file.source), keep);
    },
  };
}
