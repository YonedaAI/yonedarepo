import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readVersionPage, versionChoices } from './versionPages';

const repo = 'r12345678901234567890';
const signal = () => new AbortController().signal;
const entry = (version: number) => ({
  version,
  kind: 'ref_move',
  committed_at_ms: 1700000000000,
  actor: 'user:owner',
  refname: 'refs/heads/topic',
  chain: `chain${version}`,
  paths: [],
});
const asc = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => entry(from + i));
const page = (from = 503, to = 454) => ({
  format: 'recent-versions-v1',
  version: 503,
  history_chain: 'chain503',
  entries: asc(to, from).reverse(),
  next_before: to > 1 ? to : null,
});
let calls: string[];
let respond: (url: URL) => Response | Promise<Response>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      calls.push(path);
      return Promise.resolve(respond(new URL(path, 'https://local')));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
it('reads newest first through the advertised endpoint and pins an older cursor', async () => {
  respond = (u) => Response.json(u.searchParams.has('before') ? page(453, 404) : page());
  const first = await readVersionPage(repo, true, 503, false, signal());
  expect(first.entries[0].version).toBe(503);
  const next = await readVersionPage(repo, true, 503, false, signal(), first);
  expect(next.entries[0].version).toBe(453);
  expect(calls[1]).toContain('through=503');
  expect(calls[1]).toContain('history_chain=chain503');
  expect(calls[1]).toContain('before=454');
});
it('does not treat an ignored descending request or missing marker as a recent page', async () => {
  respond = () => Response.json({ version: 503, entries: asc(1, 50) });
  await expect(readVersionPage(repo, true, 503, false, signal())).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
it('old/off servers use supported ascending windows then reverse the exact newest range', async () => {
  respond = (u) => {
    expect(u.searchParams.get('after')).toBe('453');
    expect(u.searchParams.has('desc')).toBe(false);
    return Response.json({ version: 503, entries: asc(454, 503) });
  };
  const read = await readVersionPage(repo, false, 503, true, signal());
  expect(read.entries[0].version).toBe(503);
  expect(read.next_before).toBe(454);
  expect(Object.keys(read.entries[0])).toEqual(['version', 'kind', 'committed_at_ms']);
});
it('rebases the first old-server window once when metadata is behind its current head', async () => {
  respond = (u) => {
    const after = Number(u.searchParams.get('after'));
    return Response.json({ version: 503, entries: asc(after + 1, after + 50) });
  };
  const read = await readVersionPage(repo, false, 500, false, signal());
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain('after=453');
  expect(read.entries[0].version).toBe(503);
});
it('continues across old-server archive fragments without dropping later versions', async () => {
  respond = (u) => {
    const after = Number(u.searchParams.get('after'));
    return Response.json({ version: 503, entries: asc(after + 1, after === 453 ? 475 : 503) });
  };
  const read = await readVersionPage(repo, false, 503, false, signal());
  expect(calls).toHaveLength(2);
  expect(read.entries).toHaveLength(50);
  expect(read.entries[0].version).toBe(503);
});
it('rejects an old server that ignores after instead of presenting its oldest entries as newest', async () => {
  respond = () => Response.json({ version: 503, entries: asc(1, 50) });
  await expect(readVersionPage(repo, false, 503, false, signal())).rejects.toThrow(
    'Versions changed',
  );
});
it('anchors legacy older pages and refuses a reset reusing the same version numbers', async () => {
  respond = (u) => {
    const after = Number(u.searchParams.get('after'));
    const size = Number(u.searchParams.get('limit'));
    return Response.json({ version: 503, entries: asc(after + 1, after + size) });
  };
  const first = await readVersionPage(repo, false, 503, false, signal());
  const older = await readVersionPage(repo, false, 503, false, signal(), first);
  expect(older.entries[0].version).toBe(453);
  expect(calls[1]).toContain('after=502&limit=1');
  respond = () => Response.json({ version: 503, entries: [{ ...entry(503), chain: 'replaced' }] });
  await expect(readVersionPage(repo, false, 503, false, signal(), first)).rejects.toThrow(
    'Versions changed',
  );
});
it('only explicit disabled capability permits fallback; admission denials never do', async () => {
  respond = (u) =>
    u.pathname.endsWith('/versions')
      ? Response.json({ error: { code: 'NOT_SUPPORTED', message: 'Off' } }, { status: 400 })
      : Response.json({ version: 503, entries: asc(454, 503) });
  expect((await readVersionPage(repo, true, 503, false, signal())).entries[0].version).toBe(503);
  for (const status of [401, 403, 404, 410]) {
    calls = [];
    respond = () => Response.json({ error: { code: 'GONE', message: 'No access' } }, { status });
    await expect(readVersionPage(repo, true, 503, false, signal())).rejects.toThrow('No access');
    expect(calls).toHaveLength(1);
  }
});
it('preserves an explicit older selected version before that page loads, without duplication', () => {
  const entries = [entry(503), entry(502)];
  expect(versionChoices(entries, 7).map((e) => e.version)).toEqual([7, 503, 502]);
  expect(versionChoices(entries, 503).map((e) => e.version)).toEqual([503, 502]);
  expect(versionChoices(entries, 0)[0].version).toBe(0);
});
