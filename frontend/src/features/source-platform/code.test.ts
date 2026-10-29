// The Code tab's pure parts: file activity from the log, the README reader, the file table,
// tag resolution and the landing summary.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileTable } from './FileTable';
import { ago, directoryActivity, type LogEntry, principalName } from './fileActivity';
import { blocks, Markdown } from './markdown';
import { apiRef } from './RepoFiles';
import { landingNeeds } from './repoStatus';

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const entry = (version: number, paths: string[], refname = 'refs/heads/main'): LogEntry => ({
  version,
  kind: 'commit',
  refname,
  new: sha(version),
  paths: paths.map((path) => ({ path, op: 'modify' })),
  actor: 'user:ada',
  committed_at_ms: version * 1000,
});

describe('directory activity', () => {
  const log = [
    entry(1, ['README.md', 'src/a.rs', 'src/net/b.rs']),
    entry(2, ['src/net/b.rs']),
    entry(3, ['docs/x.md'], 'refs/heads/dev'),
    entry(4, ['src/a.rs']),
  ];
  it('dates each entry by the newest change under it on that branch', () => {
    const root = directoryActivity(log, 'main', '', ['README.md', 'src', 'docs']);
    expect(root.get('README.md')?.version).toBe(1);
    expect(root.get('src')?.version).toBe(4);
    expect(root.has('docs')).toBe(false); // changed only on dev
    const src = directoryActivity(log, 'main', 'src', ['a.rs', 'net']);
    expect(src.get('net')).toMatchObject({ version: 2, commit: sha(2), at: 2000 });
    expect(directoryActivity(log, 'dev', '', ['docs']).get('docs')?.version).toBe(3);
  });
  it('reads as of a version for time travel, and never matches a name prefix', () => {
    expect(directoryActivity(log, 'main', '', ['src'], 3).get('src')?.version).toBe(2);
    expect(directoryActivity([entry(5, ['srcs/z'])], 'main', '', ['src']).size).toBe(0);
  });
  it('words ages and principals', () => {
    expect(ago(0, 30_000)).toBe('just now');
    expect(ago(0, 3 * 86_400_000)).toBe('3 days ago');
    expect(ago(0, 86_400_000)).toBe('yesterday');
    expect(principalName('user:ada')).toBe('ada');
    expect(principalName('token:ci')).toBe('ci (token)');
    expect(principalName('system')).toBe('system');
  });
});

describe('README reader', () => {
  it('parses headings, lists, code, quotes and paragraphs', () => {
    const parsed = blocks(
      '# T\n\nSome *text*\nmore.\n\n- a\n- b\n\n```sh\nnpm i\n```\n> q\n---\n1. one',
    );
    expect(parsed.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'code',
      'quote',
      'rule',
      'list',
    ]);
    expect(parsed[1]).toEqual({ kind: 'paragraph', text: 'Some *text* more.' });
  });
  it('renders inline markup and never live markup or unsafe links', () => {
    const out = html(Markdown, {
      source:
        '# Title\n\nUse `x<y>` **now** and [docs](https://e.com) or [js](javascript:alert(1)).\n\n<script>alert(1)</script>',
    });
    expect(out).toContain('<h2>Title</h2>');
    expect(out).toContain('<code>x&lt;y&gt;</code>');
    expect(out).toContain('<strong>now</strong>');
    expect(out).toContain('href="https://e.com"');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('&lt;script&gt;');
  });
  it('reads pipe tables, with an escaped bar inside a cell', () => {
    const parsed = blocks('| A | B |\n|---|:-:|\n| `a\\|b` | 2 |\nafter');
    expect(parsed).toEqual([
      { kind: 'table', head: ['A', 'B'], rows: [['`a|b`', '2']] },
      { kind: 'paragraph', text: 'after' },
    ]);
    expect(blocks('| not | a table |\nplain')[0].kind).toBe('paragraph');
    expect(html(Markdown, { source: '| A |\n|---|\n| **x** |' })).toContain(
      '<th scope="col">A</th>',
    );
  });
  it('makes same-site links live only through a resolver, never protocol-relative ones', () => {
    const source = '[docs](/docs/cli) [evil](//e.com/x)';
    const plain = html(Markdown, { source });
    expect(plain).not.toContain('href');
    const link = (path: string) => ({ href: `/site${path}`, onClick: () => {} });
    const resolved = html(Markdown, { source, link, shift: 0, anchors: true });
    expect(resolved).toContain('href="/site/docs/cli"');
    expect(resolved).not.toContain('e.com');
    expect(html(Markdown, { source: '## Hi there', shift: 0, anchors: true })).toBe(
      '<h2 id="hi-there">Hi there</h2>',
    );
  });
});

describe('file table', () => {
  const link = (path: string, children: ReactNode) =>
    createElement('a', { href: `/p/${path}`, 'data-entry': true }, children);
  const commitLink = (commit: string, children: ReactNode) =>
    createElement('a', { href: `/c/${commit}` }, children);
  const entries = [
    { name: 'z.txt', type: 'blob', id: '1' },
    { name: 'src', type: 'tree', id: '2' },
    { name: 'a.txt', type: 'blob', id: '3' },
  ];
  it('lists folders first, with the last change and its age, and a parent row below the root', () => {
    const activity = directoryActivity([entry(1, ['src/a', 'a.txt'])], 'main', 'lib', []);
    const root = html(FileTable, {
      dir: '',
      entries,
      activity: new Map([['src', { commit: sha(1), at: 0, actor: 'u', version: 1 }]]),
      messages: new Map([[sha(1), 'Add src']]),
      now: 2 * 3_600_000,
      link,
      commitLink,
    });
    expect(root.indexOf('src')).toBeLessThan(root.indexOf('a.txt'));
    expect(root.indexOf('a.txt')).toBeLessThan(root.indexOf('z.txt'));
    expect(root).toContain('>Add src</a>');
    expect(root).toContain('2 hours ago');
    expect(root).not.toContain('parent directory');
    const nested = html(FileTable, {
      dir: 'src/net',
      entries: [],
      activity,
      messages: new Map(),
      link,
      commitLink,
    });
    expect(nested).toContain('href="/p/src"');
    expect(nested).toContain('aria-label="Files in src/net"');
  });
});

describe('refs and landing', () => {
  it('reads a tag at its commit and a branch by name', () => {
    const refs = [{ name: 'refs/tags/v1', commit_id: sha(7), version: 2 }];
    expect(apiRef('main', refs)).toBe('main');
    expect(apiRef('refs/tags/v1', refs)).toBe(sha(7));
    expect(apiRef('refs/tags/v2', refs)).toBeUndefined();
  });
  it('says what landing needs', () => {
    expect(landingNeeds({ approvals: 1, required_checks: ['yoneda-checks'] })).toEqual([
      '1 approval',
      'check yoneda-checks',
    ]);
    expect(
      landingNeeds({
        approvals: 2,
        required_checks: ['review'],
        auto_approve: ['comment_only'],
        runners: { review: { kind: 'model', rubric: 'r' } },
      }),
    ).toEqual(['2 approvals', 'auto-approves comment only', 'AI check review']);
    expect(landingNeeds({ approvals: 0, required_checks: [] })).toEqual([]);
  });
});
