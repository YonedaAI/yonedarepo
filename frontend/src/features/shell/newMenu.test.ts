// The rail's + button: a menu of the two ways to get a repository, and the dialog behind the
// second.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addedRepo } from '../source-platform/importModel';
import { GitHubImportDialog, requestImport } from './GitHubImportDialog';
import { GitHubRepoList } from './GitHubRepoList';
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
    expect(rows.map((row) => row[2])).toEqual([
      'Create repository',
      'Add GitHub repository',
      'Add public repository',
    ]);
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
    expect(html).toContain('Every branch and tag is imported');
    expect(html).not.toContain('5,000');
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

describe('a GitHub repository already added', () => {
  const own = {
    id: 'r1',
    name: 'rad-belden',
    owner: 'user:ada',
    owner_handle: 'ada',
    role: 'owner',
  };
  const other = { id: 'r2', name: 'rad-belden', owner_handle: 'ada', role: 'read' };
  it('is the account own repository of that name, whatever the case', () => {
    expect(addedRepo([own], 'ada', 'Rad-Belden')?.id).toBe('r1');
  });
  it('is not one under another owner, or one the account only reads', () => {
    expect(addedRepo([own], 'acme', 'rad-belden')).toBeUndefined();
    expect(addedRepo([other], 'ada', 'rad-belden')).toBeUndefined();
  });
  it('says Added on its row, and the others say what they are', () => {
    const row = { id: 1, full_name: 'MagnetonIO/rad-belden', private: true } as never;
    const fresh = { id: 2, full_name: 'MagnetonIO/whisper', private: false } as never;
    const list = renderToStaticMarkup(
      createElement(GitHubRepoList, {
        repositories: [row, fresh],
        matching: [row, fresh],
        addedOf: (name: string) => (name === 'MagnetonIO/rad-belden' ? 'r1' : undefined),
        busy: false,
        onPick: () => {},
        onOpen: () => {},
        onOpenGitHub: () => {},
      }),
    );
    expect(list).toMatch(/rad-belden<\/span><small>Added<\/small>/);
    expect(list).toMatch(/whisper<\/span><small>Public<\/small>/);
  });
});
