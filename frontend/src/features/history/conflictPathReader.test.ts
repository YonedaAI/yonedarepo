import { expect, it, vi } from 'vitest';
import { createConflictPathReader } from './conflictPathReader';

const ref = { version: 1 as const, id: 'paths:test', digest: 'a'.repeat(64), count: 20000 };
const body = {
  version: 1,
  conflict_id: 'conflict',
  section: 'declared_paths',
  items: ['src/', '東京/file.ts'],
  next_cursor: '東京/file.ts',
  has_more: true,
  total: 20000,
  digest: ref.digest,
  paths_ref: ref,
};
it('reads a 50-path owner page using exact conflict, section and immutable digest, preserving Unicode cursor', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body),
  );
  const result = await createConflictPathReader(fetcher as typeof fetch)(
    'repo',
    'conflict',
    'declared_paths',
    ref,
    'éarlier/',
  );
  expect(result.items).toEqual(body.items);
  const [input, options] = fetcher.mock.calls[0],
    url = new URL(String(input), 'https://example.invalid');
  expect(url.searchParams.get('after')).toBe('éarlier/');
  expect(url.searchParams.get('section')).toBe('declared_paths');
  expect(url.searchParams.get('limit')).toBe('50');
  expect(url.searchParams.get('expected_digest')).toBe(ref.digest);
  expect(options?.method).toBe('GET');
  expect(options?.body).toBeUndefined();
});
it('refuses other conflict/section/digest, unsafe paths and replayed cursors instead of returning empty scope', async () => {
  for (const patch of [
    { conflict_id: 'other' },
    { section: 'conflict_paths' },
    { digest: 'b'.repeat(64) },
    { items: ['../private'] },
    { next_cursor: 'again' },
  ]) {
    await expect(
      createConflictPathReader((async () => Response.json({ ...body, ...patch })) as typeof fetch)(
        'repo',
        'conflict',
        'declared_paths',
        ref,
        'again',
      ),
    ).rejects.toThrow();
  }
});
it('keeps the not-yet-rebuilt native endpoint unavailable with a read-only retry, never a successful empty page', async () => {
  await expect(
    createConflictPathReader((async () =>
      Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })) as typeof fetch)(
      'repo',
      'conflict',
      'declared_paths',
      ref,
      null,
    ),
  ).rejects.toThrow(/unavailable.*refresh/i);
});
