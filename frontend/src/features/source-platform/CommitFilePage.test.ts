// The web commit on the Files page: who is offered it, and what the form asks for.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing } from './codeData';
import type { RepoStatus } from './repoStatus';
import type { SourceRoute } from './sourceRoute';

const listing: { value?: Listing } = {};
vi.mock('./codeData', async (actual) => ({
  ...(await actual<typeof import('./codeData')>()),
  useListing: () => ({ value: listing.value, reload: () => {} }),
  useActivity: () => new Map(),
}));
vi.mock('./useSource', () => ({
  useSource: () => ({ loading: true, reload: () => {} }),
}));

const { RepoFiles } = await import('./RepoFiles');
const { CommitFile } = await import('./CommitFile');

const REPO = 'r0123456789abcdef0123';
const HEAD = 'a'.repeat(40);
type Files = Extract<SourceRoute, { view: 'files' }>;
const route = (over: Partial<Files> = {}): Files => ({
  view: 'files',
  repo: REPO,
  path: '',
  ref: 'main',
  ...over,
});
const status = (viewer: unknown) =>
  ({ name: 'demo', refs: [], version: 1, viewer }) as unknown as RepoStatus;
const WRITER = { owner: false, role: 'write' };
const page = (r: Files, viewer: unknown = WRITER) =>
  renderToStaticMarkup(
    createElement(RepoFiles, {
      route: r,
      status: status(viewer),
      navigate: () => {},
      account: 'ada',
    }),
  );

beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'https://dev.example' } });
  listing.value = { kind: 'tree', commit: HEAD, entries: [] };
});
afterEach(() => vi.unstubAllGlobals());

describe('the Files page', () => {
  it('offers a writer Add file', () => {
    expect(page(route())).toContain('Add file');
  });
  it('offers nothing to a reader or a public visitor', () => {
    expect(page(route(), { owner: false, role: 'read' })).not.toContain('Add file');
    expect(page(route(), { owner: false, role: null, public: true })).not.toContain('Add file');
  });
  it('offers nothing on an old version or a tag: neither can move', () => {
    expect(page(route({ at: 3 }))).not.toContain('Add file');
    expect(page(route({ ref: 'refs/tags/v1' }))).not.toContain('Add file');
  });
  it('offers Edit on a text file, not on a binary one', () => {
    const file = { commit: HEAD, size: 3, content: 'x', executable: false };
    listing.value = { kind: 'file', encoding: 'utf-8', ...file };
    expect(page(route({ path: 'a.ts' }))).toContain('>Edit<');
    listing.value = { kind: 'file', encoding: 'base64', ...file };
    expect(page(route({ path: 'a.bin' }))).not.toContain('>Edit<');
  });
});

const form = (props: Partial<Parameters<typeof CommitFile>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(CommitFile, {
      repo: REPO,
      place: { from: 'main', head: HEAD, account: 'ada' },
      dir: '',
      onCancel: () => {},
      onCommitted: () => {},
      ...props,
    }),
  );

describe('the commit form', () => {
  it('asks for the file, its contents, a message, a branch and a goal', () => {
    const html = form();
    for (const label of ['File', 'Contents', 'Commit message', 'Branch', 'Flight plan'])
      expect(html).toContain(label);
  });
  it('commits to the branch on screen, and never offers main', () => {
    expect(form({ place: { from: 'work', head: HEAD } })).toContain('value="work"');
    expect(form()).not.toContain('value="main"');
  });
  it('starts a new file in the folder on screen', () => {
    expect(form({ dir: 'src/net' })).toContain('value="src/net/"');
  });
  it('opens an edit on the file, with its name fixed and its text in place', () => {
    const html = form({ editing: { path: 'src/a.ts', content: 'const a = 1;' } });
    expect(html).toContain('const a = 1;');
    expect(html).toContain('title="src/a.ts"');
    expect(html).not.toContain('value="src/a.ts"');
    expect(html).toContain('value="edit-src-a-ts"');
  });
});
