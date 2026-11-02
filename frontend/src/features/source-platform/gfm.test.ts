// GitHub Flavored Markdown, as a repository's README, a comment and a transcript read: what the
// old reader showed raw, and everything it must never let through. The document under test is
// real files' shapes; nothing here needs a browser.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fenceSegments } from './fenceColors';
import { fenceExtension } from './fileFacts';
import { GfmDocument } from './GfmDocument';

const render = (source: string, image?: (src: string, alt: string, key: string) => ReactNode) =>
  renderToStaticMarkup(createElement(GfmDocument, { source, image, anchors: true }));

describe('what the old reader showed raw', () => {
  it('reads reference links and images', () => {
    const html = render(
      '[![npm]](https://www.npmjs.com/package/x) and [docs][d]\n\n[npm]: https://img.shields.io/npm/v/x.svg\n[d]: https://example.com/docs\n',
    );
    expect(html).not.toContain('[npm]');
    expect(html).not.toContain('![');
    expect(html).toContain('href="https://www.npmjs.com/package/x"');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toMatch(/class="md-chip"[^>]*>npm</);
  });
  it('keeps a code fence inside a list item whole, and numbers around it', () => {
    const html = render(
      '1. First\n\n   ```sh\n   npm install\n   npm test\n   ```\n\n2. Second\n\n   - nested\n     - deeper\n\n3. Third\n',
    );
    expect(html.match(/<li/g)).toHaveLength(5);
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toContain('npm install\nnpm test');
    expect(html).toMatch(/<pre[^>]*>/);
  });
  it('turns a [!NOTE] into an alert, every kind of it', () => {
    for (const [kind, title] of [
      ['NOTE', 'Note'],
      ['TIP', 'Tip'],
      ['IMPORTANT', 'Important'],
      ['WARNING', 'Warning'],
      ['CAUTION', 'Caution'],
    ]) {
      const html = render(`> [!${kind}]\n> Read **this**.\n`);
      expect(html).not.toContain('[!');
      expect(html).toContain(`md-alert-${kind.toLowerCase()}`);
      expect(html).toContain(`>${title}<`);
      expect(html).toContain('<strong>this</strong>');
    }
    expect(render('> [!NOPE]\n> Plain quote\n')).toContain('<blockquote>');
  });
});

describe('the rest of GitHub’s Markdown', () => {
  it('reads tables, task lists, strikethrough and autolinks', () => {
    const html = render(
      '| a | b |\n|---|:-:|\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n\n~~gone~~ https://example.com/a www.example.com\n',
    );
    expect(html).toContain('markdown-table');
    expect(html).toContain('<th');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toMatch(/checked=""/);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('href="http://www.example.com"');
  });
  it('gives headings the anchors GitHub does, and links to them', () => {
    const html = render('# Getting started\n\n## Getting started\n\n[jump](#getting-started)\n');
    expect(html).toContain('id="md-getting-started"');
    expect(html).toContain('id="md-getting-started-1"');
    expect(html).toContain('href="#md-getting-started"');
  });
  it('leaves anchors out of a comment, as several sit on one page', () => {
    const html = renderToStaticMarkup(createElement(GfmDocument, { source: '# Hi\n' }));
    expect(html).not.toContain('id=');
  });
  it('reads footnotes', () => {
    const html = render('Claim[^1].\n\n[^1]: The source.\n');
    expect(html).toContain('The source.');
    expect(html).not.toContain('[^1]');
  });
});

describe('raw HTML in a README', () => {
  it('keeps the safe subset', () => {
    const html = render(
      '<details open><summary>More</summary>\n\nInside **bold**\n\n</details>\n\nPress <kbd>Ctrl</kbd>, H<sub>2</sub>O, x<sup>2</sup><br>next\n\n<a href="https://example.com">site</a>\n',
    );
    expect(html).toContain('<details');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<kbd>Ctrl</kbd>');
    expect(html).toContain('<sub>2</sub>');
    expect(html).toContain('<sup>2</sup>');
    expect(html).toContain('<br');
    expect(html).toContain('href="https://example.com"');
  });
  it('hands a relative <img> to the page, as a Markdown image', () => {
    const seen: string[] = [];
    render('<img src="./demo.gif" alt="demo" />\n', (src, alt) => {
      seen.push(`${src}|${alt}`);
      return 'IMAGE';
    });
    expect(seen).toEqual(['./demo.gif|demo']);
  });
  it('never runs anything', () => {
    const attacks = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '<a href="JaVaScRiPt:alert(1)">x</a>',
      '<a href=" javascript:alert(1)">x</a>',
      '<a href="java&#10;script:alert(1)">x</a>',
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      '<a href="vbscript:x">x</a>',
      '<iframe src="https://example.com"></iframe>',
      '<object data="x"></object>',
      '<embed src="x">',
      '<svg onload=alert(1)><circle/></svg>',
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      '<style>body{display:none}</style>',
      '<link rel=stylesheet href=https://example.com/x.css>',
      '<meta http-equiv=refresh content="0;url=https://example.com">',
      '<base href="https://example.com/">',
      '<form action="https://example.com"><input name=password><button>go</button></form>',
      '<div style="position:fixed;inset:0" onclick="alert(1)">x</div>',
      '<details ontoggle=alert(1) open>x</details>',
      '<a href="https://example.com" onclick="alert(1)" target="_self">x</a>',
      '[x](javascript:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '![x](javascript:alert(1))',
      '[x]: javascript:alert(1)\n\n[x]',
    ];
    for (const attack of attacks) {
      const html = render(attack);
      expect(html, attack).not.toMatch(
        /<(script|iframe|object|embed|svg|math|style|link|meta|base|form)\b/i,
      );
      expect(html, attack).not.toMatch(/\son[a-z]+=/i);
      expect(html, attack).not.toMatch(/\sstyle=/i);
      expect(html, attack).not.toMatch(/href="\s*(javascript|data|vbscript)/i);
      expect(html, attack).not.toMatch(/src=/i);
    }
  });
  it('opens every outside link safely', () => {
    const html = render('<a href="https://example.com" target="_self" rel="x">x</a>\n');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});

describe('images', () => {
  it('shows an outside image as a chip of its words, and never loads it', () => {
    const html = render('![build passing](https://img.shields.io/x.svg)\n');
    expect(html).toMatch(/class="md-chip"[^>]*>build passing</);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('shields.io');
  });
  it('shows nothing for an outside image with no words', () => {
    expect(render('![](https://img.shields.io/x.svg)\n')).not.toContain('md-chip');
  });
  it('keeps the page in charge of what a file names', () => {
    expect(render('![a](./a.png)\n', () => undefined)).toMatch(/md-chip[^>]*>a</);
    expect(
      render('![a](./a.png)\n', (_s, _a, key) => createElement('b', { key }, 'mine')),
    ).toContain('<b>mine</b>');
  });
});

describe('colors in a fence', () => {
  it('knows a fence’s language by its usual names', () => {
    expect(fenceExtension('python')).toBe('py');
    expect(fenceExtension('js')).toBe('js');
    expect(fenceExtension('bash')).toBe('bash');
    expect(fenceExtension('console')).toBe('sh');
    expect(fenceExtension('nothing')).toBeNull();
    expect(fenceExtension('constructor')).toBeNull();
  });
  it('uses the viewer’s own highlighting', async () => {
    const parts = await fenceSegments('python', 'def greet():\n    return 42\n');
    const colored = (parts ?? []).filter((p) => p.className);
    expect(colored.map((p) => p.text)).toEqual(expect.arrayContaining(['def', 'return', '42']));
    expect((parts ?? []).map((p) => p.text).join('')).toBe('def greet():\n    return 42\n');
  });
  it('leaves an unknown language plain', async () => {
    expect(await fenceSegments('nothing', 'x')).toBeNull();
  });
});
