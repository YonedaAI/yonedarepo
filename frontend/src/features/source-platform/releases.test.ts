// Releases as the server would render them: the list (empty, loading, failed, listed), a
// release page with notes, tag message and asset downloads, the owner's controls, and the
// requests the create form and the asset upload send.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Loaded } from './useSource';

const { ReleaseTable, NewReleaseForm } = await import('./RepoReleases');
const { ReleaseBody } = await import('./ReleaseView');
const { assetHref, assetName, byteSize, publishRelease, tagNames, uploadAsset } = await import(
  './releaseModel'
);

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const loaded = (value: Partial<Loaded<any>>): Loaded<any> => ({
  loading: false,
  reload: () => {},
  ...value,
});
const repo = 'r0123456789abcdef0123';
const commit = 'a'.repeat(40);
const sha256 = 'f'.repeat(64);
const release = {
  tag: 'v1.0',
  title: 'First cut',
  notes: 'Line one\n<script>alert(1)</script>',
  created_by: 'user:ada',
  created_at: 1,
  commit_id: commit,
  asset_count: 1,
};
const noop = () => {};

afterEach(() => vi.unstubAllGlobals());

describe('release list', () => {
  const table = (releases: Loaded<any>) =>
    html(ReleaseTable, { releases, hrefOf: (t: string) => `/r/${t}`, onOpen: noop });
  it('shows loading, failure and an empty state', () => {
    expect(table({ loading: true, reload: noop })).toContain('Loading releases');
    expect(table(loaded({ error: 'boom' }))).toContain('boom');
    expect(table(loaded({ data: { releases: [] } }))).toContain('No releases yet');
  });
  it('lists each release with its tag, commit and assets', () => {
    const list = table(loaded({ data: { releases: [release] } }));
    expect(list).toContain('href="/r/v1.0"');
    expect(list).toContain('First cut');
    expect(list).toContain(commit.slice(0, 10));
    expect(list).toContain('1 asset');
  });
});

describe('release page', () => {
  const detail = {
    ...release,
    assets: [
      {
        name: 'app.tar',
        size: 2048,
        sha256,
        content_type: 'application/x-tar',
        uploaded_by: 'user:ada',
        uploaded_at: 2,
      },
    ],
    annotated: {
      id: 'b'.repeat(40),
      message: 'Tagged it\n',
      tagger: { name: 'Ada', email: 'a@x', time: 1 },
    },
  };
  const page = (owner: boolean) =>
    html(ReleaseBody, {
      repo,
      release: loaded({ data: detail }),
      owner,
      onCommit: noop,
      onChanged: noop,
      onDeleted: noop,
    });
  it('shows notes as text, the tag message and asset downloads with sha256', () => {
    const shown = page(false);
    expect(shown).toContain('&lt;script&gt;');
    expect(shown).not.toContain('<script>');
    expect(shown).toContain('Tagged it');
    expect(shown).toContain(`href="/api/v1/repos/${repo}/releases/v1.0/assets/app.tar"`);
    expect(shown).toContain(sha256);
    expect(shown).toContain('2.0 KiB');
    expect(shown).not.toContain('Upload asset');
  });
  it('gives the owner upload and delete', () => {
    const shown = page(true);
    expect(shown).toContain('Upload asset');
    expect(shown).toContain('Delete release');
  });
});

describe('release requests', () => {
  it('publishes with the tag, trimmed title and notes', async () => {
    const fetch = vi.fn(async () => Response.json(release));
    vi.stubGlobal('fetch', fetch);
    await publishRelease(repo, { tag: 'v1.0', title: ' First cut ', notes: ' n ' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/repos/${repo}/releases`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ tag: 'v1.0', title: 'First cut', notes: 'n' });
  });
  it('uploads raw bytes and surfaces the server error', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { code: 'ALREADY_EXISTS', message: 'taken' } }, { status: 409 }),
    );
    vi.stubGlobal('fetch', fetch);
    const file = new Blob(['x'], { type: 'text/plain' });
    await expect(uploadAsset(repo, 'team/v2', 'a.txt', file)).rejects.toThrow('taken');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/repos/${repo}/releases/team%2Fv2/assets/a.txt`);
    expect([init.method, init.body]).toEqual(['PUT', file]);
  });
  it('offers existing tags and safe asset names', () => {
    expect(
      tagNames({ 'refs/heads/main': commit, 'refs/tags/v2': commit, 'refs/tags/v1': commit }),
    ).toEqual(['v1', 'v2']);
    expect(assetName('my build (1).zip')).toBe('my-build-1-.zip');
    expect(assetName('.hidden')).toBe('hidden');
    expect(assetHref(repo, 'v1', 'a b')).toContain('/assets/a%20b');
    expect(byteSize(10)).toBe('10 B');
    expect(html(NewReleaseForm, { repo, tags: ['v1'], onCreated: noop })).toContain('New release');
  });
});
