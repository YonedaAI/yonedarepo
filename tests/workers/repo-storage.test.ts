// A repository's database size: read from the authority, sampled by the derive job into the
// activity row (no new D1 write), and logged once when it crosses an alert level.
import { expect, it, vi } from 'vitest';
import { touchActivity } from '../../cloudflare/worker/repo-activity';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import { caller } from '../../cloudflare/worker/repo-ops';
import { sampleStorage } from '../../cloudflare/worker/repo-storage';
import { api, author, bindings, countingOps, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function repository(name: string) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, files: [file('a.txt', 'a\n')], author } });
  return created.body.id as string;
}

const sampled = async (repo: string) =>
  (await bindings.INDEX.prepare('SELECT db_bytes FROM platform_activity WHERE repo=?').bind(repo).first<{ db_bytes: number | null }>())?.db_bytes;
const job = (repo: string) => ({ v: 1, kind: 'platform_derive', repo_id: repo, job_id: 'main' }) as any;
/** D1 writes `target` sends, by the first word of the statement's table. */
function countingWrites(target: typeof scoped) {
  const writes: string[] = [];
  const note = (sql: string) => {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql);
  };
  const INDEX = new Proxy(target.INDEX, {
    get(d1, key) {
      if (key === 'prepare')
        return (sql: string) => {
          note(sql);
          return d1.prepare(sql);
        };
      const value = Reflect.get(d1, key);
      return typeof value === 'function' ? value.bind(d1) : value;
    },
  });
  return { env: { ...target, INDEX } as typeof scoped, writes };
}

it('reads a repository database size and row estimates through the real authority', async () => {
  const repo = await repository('sized');
  const storage = await caller(scoped, repo, { _system: 'derive' })({ op: 'repo_storage' });
  expect(storage.db_bytes).toBeGreaterThan(4096);
  expect(storage.table_rows.commits).toBeGreaterThan(0);
  expect(storage.table_rows.txlog).toBeGreaterThan(0);
});

it('samples the size in the derive job without a D1 write of its own, at most every 10 minutes', async () => {
  const repo = await repository('sampled');
  const { env, writes } = countingWrites(scoped);
  const { env: target, take } = countingOps(env);
  await deriveAfterLanding(target, job(repo));
  expect(take().repo_storage).toBe(1);
  expect(await sampled(repo)).toBeGreaterThan(4096);
  expect(writes.filter((sql) => /platform_activity/.test(sql))).toHaveLength(1);
  await deriveAfterLanding(target, job(repo));
  expect(take().repo_storage).toBeUndefined();
});

it('samples again once 10 minutes pass', async () => {
  const repo = await repository('resampled');
  const start = 1_900_000_000_000;
  expect(await sampleStorage(scoped, repo, start)).toBeGreaterThan(4096);
  expect(await sampleStorage(scoped, repo, start + 599_999)).toBeUndefined();
  expect(await sampleStorage(scoped, repo, start + 600_000)).toBeGreaterThan(4096);
});

it('keeps the sampled size when anything else touches the row', async () => {
  const repo = await repository('kept');
  await touchActivity(scoped, repo, 10, 123_456);
  await touchActivity(scoped, repo, 20);
  const row = await bindings.INDEX.prepare('SELECT touched_at,db_bytes FROM platform_activity WHERE repo=?').bind(repo).first<any>();
  expect(row).toEqual({ touched_at: 20, db_bytes: 123_456 });
});

it('never throws from a failed touch, with or without a size', async () => {
  const broken = { ...scoped, INDEX: { prepare: () => { throw new Error('D1 is down'); } } } as unknown as typeof scoped;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(touchActivity(broken, 'r0', 1)).resolves.toBeUndefined();
  await expect(touchActivity(broken, 'r0', 1, 5)).resolves.toBeUndefined();
  warn.mockRestore();
});

it('a failed size read only skips the sample', async () => {
  const repo = await repository('unsized');
  const down = { ...scoped, SOURCE_REPOS: { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error('authority down'); } }) } } as unknown as typeof scoped;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(sampleStorage(down, repo, 1)).resolves.toBeUndefined();
  warn.mockRestore();
});

it('logs repo.storage once per level crossed, not every sample', async () => {
  const repo = await repository('alerted');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const crossings = () =>
    log.mock.calls.map(([line]) => JSON.parse(String(line))).filter((e) => e.event === 'repo.storage');
  await touchActivity(scoped, repo, 1, 4_999_999_999);
  expect(crossings()).toEqual([]);
  await touchActivity(scoped, repo, 2, 5_000_000_000);
  await touchActivity(scoped, repo, 3, 5_100_000_000);
  expect(crossings()).toEqual([{ event: 'repo.storage', repo, level: 5_000_000_000, db_bytes: 5_000_000_000 }]);
  await touchActivity(scoped, repo, 4, 9_500_000_000);
  expect(crossings().map((e) => e.level)).toEqual([5_000_000_000, 8_000_000_000, 9_000_000_000]);
  // Back under a level (data deleted) and over it again is a new crossing.
  await touchActivity(scoped, repo, 5, 7_000_000_000);
  await touchActivity(scoped, repo, 6, 8_000_000_000);
  expect(crossings().map((e) => e.level)).toEqual([5_000_000_000, 8_000_000_000, 9_000_000_000, 8_000_000_000]);
  log.mockRestore();
});
