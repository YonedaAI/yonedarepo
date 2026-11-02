// The Code tab's pure parts: file activity from the log, the README reader, the file table,
// tag resolution and the landing summary.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommentItem } from './ChangeThread';
import { FileTable } from './FileTable';
import { ago, writtenAt } from './fileActivity';
import { blocks, Markdown } from './markdown';
import { accountName, HIDDEN_ACCOUNT, principalName, ShowEmailsContext } from './people';
import { apiRef } from './RepoFiles';
import { landingNeeds } from './repoStatus';

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const sha = (n: number) => String(n).repeat(40).slice(0, 40);
describe('a comment on a Landing', () => {
  const body = (text: string) =>
    html(CommentItem, {
      comment: {
        id: 1,
        principal: 'token:yoneda-managed-agents',
        body: text,
        at: 1,
        resolved_at: null,
      },
    });
  const RUN = 'r7d8d4bee74abf3a3a49e-sl-1-db7d52c6dd26';

  it('reads as written, not as its Markdown', () => {
    const page = body('**Slop review**: low on `db7d52c6dd`\n\nNothing to tidy.');
    expect(page).toContain('<strong>Slop review</strong>');
    expect(page).toContain('<code>db7d52c6dd</code>');
    expect(page).not.toContain('**');
  });
  it('leaves off the reference a run finds its comment by', () => {
    for (const ref of [`${RUN}#summary`, `${RUN}#3`]) {
      const page = body(`Done.\n\n_Slop review by YonedaRepo managed agents · ${ref}_`);
      expect(page).toContain('<em>Slop review by YonedaRepo managed agents</em>');
      expect(page).not.toContain(RUN);
    }
  });
  it('keeps what a person wrote, and never as markup', () => {
    expect(body('See a · b_')).toContain('See a · b_');
    expect(body('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});

describe('ages', () => {
  it('words ages and principals', () => {
    expect(ago(0, 30_000)).toBe('just now');
    expect(ago(0, 3 * 86_400_000)).toBe('3 days ago');
    expect(ago(0, 86_400_000)).toBe('yesterday');
    expect(principalName('user:ada')).toBe('ada');
    expect(principalName('token:ci')).toBe('ci (token)');
    expect(principalName('agent:ada/review-bot')).toBe('review-bot (agent of ada)');
    expect(principalName('agent:ada@example.com/bot')).toBe(`bot (agent of ${HIDDEN_ACCOUNT})`);
    expect(principalName('system')).toBe('system');
  });
  it('never shows an email-named account unless the page allows it', () => {
    expect(principalName('user:ada@example.com')).toBe(HIDDEN_ACCOUNT);
    expect(principalName('user:ada@example.com', true)).toBe('ada@example.com');
    expect(principalName('break-glass:user:ada@example.com')).toBe(
      `break-glass:user:${HIDDEN_ACCOUNT}`,
    );
    expect(accountName('ada.l+git@mail.example.co.uk')).toBe(HIDDEN_ACCOUNT);
    expect(accountName('ada')).toBe('ada');
    const comment = {
      id: 1,
      commit: 'a'.repeat(40),
      path: null,
      line: null,
      side: null,
      body: 'Looks good',
      principal: 'user:ada@example.com',
      at: 0,
      resolved_at: null,
    };
    const page = (show?: boolean) => {
      const item = createElement(CommentItem, { comment });
      return renderToStaticMarkup(
        show === undefined
          ? item
          : createElement(ShowEmailsContext.Provider, { value: show }, item),
      );
    };
    // Outside a repository page, and for a viewer who is not a member, the address is hidden.
    expect(page()).not.toContain('@');
    expect(page(false)).toContain(`<strong>${HIDDEN_ACCOUNT}</strong>`);
    expect(page(true)).toContain('ada@example.com');
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
    const written = { commit: sha(1), message: 'Add src', principal: 'platform:import' };
    const root = html(FileTable, {
      dir: '',
      entries,
      activity: new Map([
        ['src', { ...written, author_name: 'Ada', authored_at: 0, recorded_at: 3_600_000 }],
      ]),
      now: 2 * 3_600_000,
      link,
      commitLink,
    });
    expect(root.indexOf('src')).toBeLessThan(root.indexOf('a.txt'));
    expect(root.indexOf('a.txt')).toBeLessThan(root.indexOf('z.txt'));
    expect(root).toContain('>Add src</a>');
    expect(root).toContain('>Ada<');
    expect(root).toContain('2 hours ago');
    expect(root).not.toContain('platform:import');
    expect(root).not.toContain('parent directory');
    const nested = html(FileTable, {
      dir: 'src/net',
      entries: [],
      activity: new Map(),
      link,
      commitLink,
    });
    expect(nested).toContain('href="/p/src"');
    expect(nested).toContain('aria-label="Files in src/net"');
  });
});

describe('when a commit was written', () => {
  const base = { commit: sha(1), message: 'm', principal: 'u', recorded_at: 9 };
  it('is the author’s own time, and when it was recorded for a commit from before', () => {
    expect(writtenAt({ ...base, authored_at: 5 })).toBe(5);
    expect(writtenAt({ ...base, authored_at: null })).toBe(9);
    expect(writtenAt(base)).toBe(9);
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
