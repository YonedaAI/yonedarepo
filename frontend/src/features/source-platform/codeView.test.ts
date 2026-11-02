// The file view's pure parts: sizes in words, which language a path reads as, and what Markdown
// may do with what a file names.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import css from '../../styles/theme.css?raw';
import { FileHeader } from './FileHeader';
import { fileSize, languageOf, PLAIN_BYTES } from './fileFacts';
import { Markdown } from './markdown';
import { imageType, repoImagePath } from './repoImage';

describe('a file’s size', () => {
  it('reads in plain units', () => {
    expect(fileSize(2867)).toBe('2.8 KB');
    expect(fileSize(512)).toBe('512 bytes');
    expect(fileSize(1)).toBe('1 byte');
    expect(fileSize(0)).toBe('0 bytes');
    expect(fileSize(3 * 1024 * 1024)).toBe('3 MB');
  });
  it('shows in the header, not in bytes', () => {
    const html = renderToStaticMarkup(createElement(FileHeader, { path: 'src/a.ts', size: 2867 }));
    expect(html).toContain('2.8 KB');
    expect(html).not.toContain('2867');
    expect(html).toContain('aria-label="Copy path"');
  });
});

describe('a file’s language', () => {
  it('follows its name', () => {
    expect(languageOf('src/app.tsx')).toBe('typescript');
    expect(languageOf('a/b/lib.rs')).toBe('rust');
    expect(languageOf('README.MD')).toBe('markdown');
    expect(languageOf('.zshrc')).toBe('shell');
  });
  it('is plain text when nothing fits', () => {
    expect(languageOf('LICENSE')).toBeNull();
    expect(languageOf('a.unknown')).toBeNull();
    expect(languageOf('constructor')).toBeNull();
    expect(languageOf('x.constructor')).toBeNull();
  });
  it('has a limit a page can bear', () => {
    expect(PLAIN_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe('a relative image', () => {
  it('resolves from the file, inside the repository', () => {
    expect(repoImagePath('README.md', './demo.gif')).toBe('demo.gif');
    expect(repoImagePath('docs/guide/a.md', '../img/x.png')).toBe('docs/img/x.png');
    expect(repoImagePath('docs/a.md', '/assets/x.png')).toBe('assets/x.png');
    expect(repoImagePath('README.md', 'my%20demo.webp?raw=true#top')).toBe('my demo.webp');
  });
  it('never leaves the repository or names another scheme', () => {
    for (const src of [
      'https://example.com/a.png',
      '//example.com/a.png',
      'javascript:alert(1)//.png',
      'data:image/png;base64,AAAA',
      'blob:https://x/y.png',
      'file:///etc/a.png',
      '../a.png',
      'docs/../../a.png',
      '%2e%2e/a.png',
      '..\\a.png',
      'a%5cb.png',
      'a%00.png',
      '%zz.png',
      '',
    ])
      expect(repoImagePath('README.md', src), src).toBeNull();
  });
  it('is only ever a raster image', () => {
    expect(repoImagePath('README.md', 'a.svg')).toBeNull();
    expect(repoImagePath('README.md', 'a.html')).toBeNull();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>');
    expect(imageType(svg)).toBeNull();
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe('image/png');
    expect(imageType(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });
});

describe('Markdown from a repository', () => {
  const render = (source: string, image?: (src: string, alt: string) => string) =>
    renderToStaticMarkup(createElement(Markdown, { source, image: image as never }));

  it('hands a relative image to the page, and keeps only its words otherwise', () => {
    expect(render('![a demo](./demo.gif)', (src, alt) => `[${alt}:${src}]`)).toContain(
      '[a demo:./demo.gif]',
    );
    expect(render('![a demo](./demo.gif)')).toContain('a demo');
    expect(render('![a demo](./demo.gif)')).not.toContain('<img');
  });
  it('never makes a live link or markup of what a file says', () => {
    const html = render(
      '[x](javascript:alert(1)) [y](data:text/html,hi) [z](vbscript:x) <img src=x onerror=alert(1)> <script>alert(1)</script>',
    );
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('href="data');
    expect(html).not.toContain('href="vbscript');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });
  it('keeps safe links safe', () => {
    const html = render('[x](https://example.com)');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});

describe('syntax colors', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  it('read on the code surface in both themes', () => {
    const themes = [
      ...css.matchAll(
        /--bg: (#[0-9a-f]{6});(?:(?!--bg:)[\s\S])*?--syntax-property: #[0-9a-f]{6};/g,
      ),
    ];
    expect(themes).toHaveLength(3);
    for (const theme of themes) {
      const [block, bg] = theme;
      const colors = [...block.matchAll(/--syntax-\w+: (#[0-9a-f]{6})/g)].map((m) => m[1]);
      expect(colors).toHaveLength(8);
      for (const color of colors) expect(contrast(color, bg), color).toBeGreaterThanOrEqual(4.5);
    }
  });
});
