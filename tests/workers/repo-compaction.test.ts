// Log compaction through the real SourceRepository DO and R2: the owner's trigger moves a
// segment of old versions to R2, the SQL tail shrinks, reads at old versions still answer
// (from the segment the adapter fetches), and a corrupted segment is refused.
import { expect, it, vi } from 'vitest';
import { compactAfterLanding, compactionJob, sweepCompaction, sweepRange } from '../../cloudflare/worker/repo-compaction';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** A repository whose log has passed 1,100 versions: 100 branches moved in batches. */
async function grown(name: string, head = 1_100) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, {
    body: { name: 'long-log', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author, tokens: [{ name: 'agent', scopes: ['read', 'write'] }] },
  });
  const id = created.body.id as string;
  const repo = `/repos/${id}`;
  const agent = { token: created.body.tokens[0].token };
  const root = created.body.commit as string;
  const child = (await api(`${repo}/commits`, agent, { body: { parent: root, changes: [file('b.txt', 'b\n')], message: 'b', author } })).body.commit;
  const at: (string | null)[] = Array(100).fill(null);
  let version = (await api(repo, owner)).body.version as number;
  while (version < head) {
    const updates = at.map((was, i) => {
      at[i] = was === root ? child : root;
      return { ref: `b${i}`, commit: at[i], expected: was };
    });
    const moved = await api(`${repo}/refs/batch`, agent, { body: { updates } });
    expect(moved.status).toBe(200);
    version = moved.body.version;
  }
  return { owner, agent, id, repo, root, version };
}

it('moves old versions to R2 segments and still answers reads at them', async () => {
  const { owner, agent, id, repo, root, version } = await grown('compactor');
  const refsAt5 = (await api(`${repo}/refs?at=5`, owner)).body.refs;
  const logAt5 = (await api(`${repo}/log?ref=b3&at=5`, owner)).body;
  expect(logAt5.commits[0].commit).toBe(root);

  // Defaults keep 10,000 versions; the owner lowers the bound. Only the owner may.
  expect((await api(`${repo}/compact`, owner, { body: {} })).body.segments).toBe(0);
  expect((await api(`${repo}/retention`, agent, { method: 'PUT', body: { keep_versions: 64 } })).status).toBe(403);
  expect((await api(`${repo}/compact`, agent, { body: {} })).status).toBe(403);
  const bound = await api(`${repo}/retention`, owner, { method: 'PUT', body: { keep_versions: 64 } });
  expect(bound.body).toEqual({ keep_versions: 64, keep_days: 30 });

  // The owner's read changes nothing, and only the owner may read it.
  expect((await api(`${repo}/compaction`, agent)).status).toBe(403);
  expect((await api(`${repo}/compaction?shards=1`, agent)).status).toBe(403);
  const unmoved = (await api(`${repo}/compaction`, owner)).body;
  expect(unmoved.shards).toBeUndefined();
  const withShards = (await api(`${repo}/compaction?shards=1`, owner)).body;
  expect(withShards.shards.db_bytes).toBeGreaterThan(0);
  expect(Object.keys(withShards.shards.table_rows)).toContain('commits');
  expect(unmoved).toMatchObject({ floor: 0, head: version, tail_rows: version, retention: { keep_versions: 64 } });
  expect(unmoved.storage.db_bytes).toBeGreaterThan(4096);
  expect((await api(`${repo}/compaction`, owner)).body.floor).toBe(0);

  const compacted = await api(`${repo}/compact`, owner, { body: {} });
  expect(compacted.status).toBe(200);
  expect(compacted.body).toMatchObject({ segments: 1, floor: 1_024, head: version, tail_rows: version - 1_024, more: false });
  expect((await api(`${repo}/compaction`, owner)).body).toMatchObject({ floor: 1_024, tail_rows: version - 1_024 });
  const listed = await bindings.OBJECTS.list({ prefix: `platform/v1/${id}/_log/` });
  expect(listed.objects.map((o) => o.key.split('/_log/')[1]).sort()).toEqual([
    'checkpoint-00000000000000000000.json',
    'segment-00000000000000000000-00000000000000001024.json',
  ]);

  // Reads below the floor answer from the segment; the tail from the anchor.
  expect((await api(`${repo}/log?ref=b3&at=5`, owner)).body).toEqual(logAt5);
  expect((await api(`${repo}/refs?at=7`, owner)).body.refs['refs/heads/b5']).toBe(root);
  expect((await api(`${repo}/refs?at=1050`, owner)).status).toBe(200);
  expect(refsAt5['refs/heads/b3']).toBe(root);

  // A segment altered in R2 is refused, not replayed.
  const key = `platform/v1/${id}/_log/segment-00000000000000000000-00000000000000001024.json`;
  const good = await (await bindings.OBJECTS.get(key))!.text();
  await bindings.OBJECTS.put(key, good.replace(/"version":9(?=[,}])/, `"version":10`));
  const refused = await api(`${repo}/log?ref=b3&at=9`, owner);
  expect(refused.body.error.code).toBe('ARCHIVE_CORRUPT');
  await bindings.OBJECTS.put(key, good);
  expect((await api(`${repo}/log?ref=b3&at=9`, owner)).status).toBe(200);
});

it('runs after landings as the platform, within the repository bound', async () => {
  const { owner, repo, id, version } = await grown('landing_compactor');
  await api(`${repo}/retention`, owner, { method: 'PUT', body: { keep_versions: 64 } });
  // The derive job's run moves the due segment with the platform's compaction role.
  expect(await compactAfterLanding(scoped, id, version)).toMatchObject({ segments: 1, floor: 1_024 });
  expect((await api(`${repo}/log?ref=b3&at=5`, owner)).status).toBe(200);
  // Then it waits out its window, and a small log is never checked at all.
  expect(await compactAfterLanding(scoped, id, version)).toBeNull();
  expect(await compactAfterLanding(scoped, 'r00000000000000000000', 10)).toBeNull();
});

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;

/** A deployment with the sweep on, whose queue only records what it was sent. */
function sweeping() {
  const sent: { body: Envelope; delaySeconds?: number }[] = [];
  const PLATFORM_QUEUE = {
    send: async (body: Envelope, options?: { delaySeconds?: number }) => void sent.push({ body, ...options }),
    sendBatch: async (messages: { body: Envelope }[]) => void sent.push(...messages),
  };
  return { env: { ...scoped, COMPACTION_SWEEP: 'on', PLATFORM_QUEUE } as unknown as Env, sent };
}

/** A time in the minute of the day whose range holds `id`. */
function minuteOf(id: string) {
  for (let m = 0; m < DAY_MINUTES; m++) {
    const [from, to] = sweepRange(m * MINUTE);
    if (from <= id && id < to) return m * MINUTE;
  }
  throw new Error(`no minute covers ${id}`);
}

it('visits the whole id space in a day, each id once', () => {
  const ranges = Array.from({ length: DAY_MINUTES }, (_, m) => sweepRange(m * MINUTE));
  for (let m = 1; m < DAY_MINUTES; m++) expect(ranges[m][0]).toBe(ranges[m - 1][1]);
  expect(ranges[0][0]).toBe('r0000');
  for (const id of ['r00000000000000000000', 'rffffffffffffffffffff'])
    expect(ranges.filter(([from, to]) => from <= id && id < to)).toHaveLength(1);
  expect(sweepRange(DAY_MINUTES * MINUTE)).toEqual(ranges[0]);
});

it('compacts a repository with no landing to run it, only behind the switch', async () => {
  const { owner, repo, id, version } = await grown('idle_compactor');
  await api(`${repo}/retention`, owner, { method: 'PUT', body: { keep_versions: 64 } });
  const now = minuteOf(id);
  expect(await sweepCompaction(scoped, now)).toBe(0);
  const { env, sent } = sweeping();
  expect((await api(`${repo}/compaction`, owner)).body).toMatchObject({ floor: 0, head: version });
  expect(await sweepCompaction(env, now)).toBeGreaterThanOrEqual(1);
  const job = sent.map((s) => s.body).find((b) => b.repo_id === id)!;
  expect(job).toMatchObject({ kind: 'platform_compact', repo_id: id });
  expect(await compactionJob(env, job)).toMatchObject({ segments: 1, floor: 1_024 });
  expect((await api(`${repo}/compaction`, owner)).body.floor).toBe(1_024);
  expect((await api(`${repo}/log?ref=b3&at=5`, owner)).status).toBe(200);
});

it('sends itself again while a sweep leaves segments due', async () => {
  const { owner, repo, id } = await grown('busy_compactor', 6_500);
  await api(`${repo}/retention`, owner, { method: 'PUT', body: { keep_versions: 64 } });
  const { env, sent } = sweeping();
  const job: Envelope = { v: 1, kind: 'platform_compact', repo_id: id, job_id: `compact-${id}` };
  expect(await compactionJob(env, job)).toMatchObject({ segments: 4, more: true });
  expect(sent).toMatchObject([{ body: job, delaySeconds: 60 }]);
  expect(await compactionJob(env, job)).toMatchObject({ segments: 2, more: false });
  expect(sent).toHaveLength(1);
}, 60_000);

it('ends quietly for a repository that has gone', async () => {
  const { owner, repo, id } = await grown('gone_compactor');
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await api(`${repo}?confirm=long-log`, owner, { method: 'DELETE' })).status).toBeLessThan(300);
  const { env, sent } = sweeping();
  const job: Envelope = { v: 1, kind: 'platform_compact', repo_id: id, job_id: `compact-${id}` };
  expect(await compactionJob(env, job)).toBeNull();
  expect(sent).toEqual([]);
  expect(logged.mock.calls.flat().join(' ')).not.toContain('compaction.failed');
  logged.mockRestore();
});

it('hydrates both recent-page dependencies when a held snapshot moves behind another archive segment', async () => {
  const { owner, repo } = await grown('recent_archived_snapshot', 2_200);
  const recent = { ...scoped, RECENT_VERSIONS: 'on' } as Env;
  const first = await api(`${repo}/versions?through=1050`, owner, {}, recent);
  expect(first.status).toBe(200);
  expect(first.body.entries[0].version).toBe(1050);
  await api(`${repo}/retention`, owner, { method: 'PUT', body: { keep_versions: 64 } });
  const compacted = await api(`${repo}/compact`, owner, { body: {} });
  expect(compacted.body.floor).toBe(2048);
  const cursor = new URLSearchParams({ through: '1050', before: '1001', history_chain: first.body.history_chain });
  const older = await api(`${repo}/versions?${cursor}`, owner, {}, recent);
  expect(older.status, JSON.stringify(older.body)).toBe(200);
  expect(older.body.entries[0].version).toBe(1000);
  expect(older.body.entries[49].version).toBe(951);
  expect(older.body.history_chain).toBe(first.body.history_chain);
});
