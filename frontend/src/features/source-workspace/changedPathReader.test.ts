import { expect, it, vi } from 'vitest';
import { createChangedPathReader } from './changedPathReader';

const ref = { version: 1 as const, id: 'paths:candidate', digest: 'a'.repeat(64), count: 20000 };
const page = {
  version: 1,
  candidate_id: 'candidate',
  items: ['src/a', 'src/b'],
  next_cursor: 'src/b',
  has_more: true,
  total: 20000,
  digest: ref.digest,
  paths_ref: ref,
};
it('reads only a bounded page of recorded changed paths with a frozen digest, never caller Git refs or source bytes', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(page),
  );
  expect(
    await createChangedPathReader(fetcher as typeof fetch)('repo', 'candidate', ref, null),
  ).toMatchObject({ items: ['src/a', 'src/b'], has_more: true });
  const [path, options] = fetcher.mock.calls[0],
    url = new URL(String(path), 'https://example.invalid');
  expect(url.searchParams.get('limit')).toBe('50');
  expect(url.searchParams.get('expected_digest')).toBe(ref.digest);
  expect(url.searchParams.get('candidate_id')).toBe('candidate');
  expect(options?.method).toBe('GET');
  expect(options?.body).toBeUndefined();
  expect(url.searchParams.has('commit')).toBe(false);
});
it('rejects another candidate, changed digest, invalid paths and a repeated page cursor rather than mixing captures', async () => {
  for (const patch of [
    { candidate_id: 'other' },
    { digest: 'b'.repeat(64) },
    { items: ['../private'] },
    { next_cursor: 'src/a' },
  ]) {
    const fetcher = async () => Response.json({ ...page, ...patch });
    await expect(
      createChangedPathReader(fetcher as typeof fetch)('repo', 'candidate', ref, 'src/a'),
    ).rejects.toThrow();
  }
});
it('does not treat an unavailable immutable path list as successful empty metadata', async () => {
  const fetcher = async () =>
    Response.json({ error: { code: 'VERSION_CONFLICT' } }, { status: 409 });
  await expect(
    createChangedPathReader(fetcher as typeof fetch)('repo', 'candidate', ref, null),
  ).rejects.toThrow(/refresh/i);
});
