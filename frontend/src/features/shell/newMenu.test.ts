// The rail's + button: a menu of the two ways to get a repository, and the dialog behind the
// second.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubImportDialog, requestImport } from './GitHubImportDialog';
import { NewMenu } from './NewMenu';

afterEach(() => vi.unstubAllGlobals());

describe('NewMenu', () => {
  const html = renderToStaticMarkup(
    createElement(NewMenu, { onCreate: () => {}, onImport: () => {} }),
  );
  it('is a menu button named New repository', () => {
    expect(html).toMatch(/<summary[^>]*role="button"/);
    expect(html).toMatch(/<summary[^>]*aria-label="New repository"/);
    expect(html).toMatch(/<summary[^>]*aria-haspopup="menu"/);
    expect(html).toMatch(/<summary[^>]*aria-expanded="false"/);
  });
  it('names its two rows, each with an icon', () => {
    expect(html).toContain('role="menu"');
    const rows = [...html.matchAll(/role="menuitem"[^>]*>(<svg.*?<\/svg>)([^<]+)</g)];
    expect(rows.map((row) => row[2])).toEqual(['Create repository', 'Add GitHub repository']);
  });
});

describe('GitHubImportDialog', () => {
  const html = renderToStaticMarkup(
    createElement(GitHubImportDialog, {
      account: 'ada',
      orgs: [{ org: 'acme', role: 'owner' }] as never,
      onClose: () => {},
      onImported: async () => {},
    }),
  );
  it('says plainly what can be added and how much of it', () => {
    expect(html).toContain('Public GitHub repositories only for now');
    expect(html).toContain('The newest 5,000 commits are imported');
  });
  it('is private by default, with the branch tucked away', () => {
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="private"/);
    expect(html).not.toMatch(/<input[^>]*checked=""[^>]*value="public"/);
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>Branch/);
    expect(html).not.toMatch(/<details[^>]* open/);
  });
  it('offers the owners the create dialog does', () => {
    expect(html).toContain('<select name="owner"');
    expect(html).toContain('acme');
  });
});

describe('requestImport', () => {
  it('posts the body to the import route and returns the new repository', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ id: 'r00000000000000000001' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const created = await requestImport({ url: 'https://github.com/a/b.git' });
    expect(created.id).toBe('r00000000000000000001');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/repos/import');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ url: 'https://github.com/a/b.git' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
