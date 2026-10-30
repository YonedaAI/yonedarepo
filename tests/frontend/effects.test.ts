// An effect's return value is its cleanup, and React calls whatever comes back. An effect
// written as `() => expression` hands React that expression's value: Chrome's
// `window.scrollTo()` now returns a Promise, so `() => window.scrollTo(…)` crashed the page
// when it unmounted ("is not a function"). Every effect has a block body and returns a cleanup
// only on purpose.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../frontend/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** `file:line` of every useEffect / useLayoutEffect whose callback is an expression body. */
export function expressionEffects(files: string[]): string[] {
  return files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/use(?:Layout)?Effect\(\s*\(\)\s*=>\s*(?![\s{])/g)].map(
      (m) => `${file.slice(ROOT.length + 1)}:${text.slice(0, m.index).split('\n').length}`,
    );
  });
}

describe('effects', () => {
  it('all have block bodies, so no value is mistaken for a cleanup', () => {
    expect(expressionEffects(sources(ROOT))).toEqual([]);
  });
});
