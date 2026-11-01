// The build's short custom property names: every definition and use moves together, and nothing
// that only looks like a custom property does.
import { expect, it } from 'vitest';
import { shortenNames } from '../../frontend/vite-css-names';

it('renames a definition and its uses alike, the most used shortest', () => {
  const css = ':root{--line:red;--muted:blue}a{color:var(--muted);border-color:var(--muted,var(--line))}';
  expect(shortenNames(css, new Set())).toBe(
    ':root{--b:red;--a:blue}a{color:var(--a);border-color:var(--a,var(--b))}',
  );
});

it('keeps a name the JavaScript spells, and never hands it out', () => {
  const css = ':root{--a:1;--avatar-size:2px}a{top:var(--a);width:var(--avatar-size)}';
  expect(shortenNames(css, new Set(['--avatar-size', '--a']))).toBe(css);
  expect(shortenNames('b{--x:1;--a:2;top:var(--x)}', new Set(['--a']))).toBe('b{--b:1;--a:2;top:var(--b)}');
});

it('leaves classes and file names that hold two dashes', () => {
  const css = '.card--wide{--x:1}@font-face{src:url(/assets/inter-a--b.woff2)}';
  expect(shortenNames(css, new Set())).toBe('.card--wide{--a:1}@font-face{src:url(/assets/inter-a--b.woff2)}');
});

it('runs past the alphabet without a repeat', () => {
  const names = Array.from({ length: 60 }, (_, i) => `--n${i}`);
  const out = shortenNames(`a{${names.map((n) => `${n}:1`).join(';')}}`, new Set());
  const short = out.match(/--[a-z]+/g) ?? [];
  expect(new Set(short).size).toBe(60);
  expect(short).toContain('--aa');
});
