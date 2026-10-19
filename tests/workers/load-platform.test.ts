// N4 platform benchmark in real workerd (DO SQLite, R2, Rust compute): concurrent writers
// commit and land through the public API, readers do warm bounded reads, and commit cost is
// compared between a small and a large repository (Scion S3). An independent model checks
// the final state: every landed file present with its content, log chain intact.
import { expect, it } from 'vitest';
import { latency } from '../../tools/load-metrics.mjs';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const WRITERS = Number(globalThis.process?.env?.PLATFORM_LOAD_WRITERS ?? 100);
const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
const timed = async <T>(work: () => Promise<T>) => {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
};

async function repoWith(owner: { cookie: string }, files: number) {
  const seed = Array.from({ length: files }, (_, i) => file(`seed/${Math.floor(i / 100)}/${i}.txt`, `seed ${i}\n`));
  const created = await api('/repos', owner, { body: { name: `load${files}`, policy: { required_checks: [], approvals: 0 }, files: seed, author } }, local);
  expect(created.status).toBe(200);
  return created.body.id as string;
}

it(`lands ${WRITERS} concurrent writers and keeps reads and commits fast`, async () => {
  const owner = { cookie: await signup('loadowner') };
  const id = await repoWith(owner, 100);
  const repo = `/repos/${id}`;
  const began = performance.now();
  const results = await Promise.all(
    Array.from({ length: WRITERS }, async (_, i) => {
      const made = await timed(() =>
        api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file(`writers/${i}.txt`, `writer ${i}\n`)], message: `writer ${i}`, author } }, local),
      );
      const landed = await timed(() => api(`${repo}/land`, owner, { body: { ref: 'main', commit: made.value.body.commit } }, local));
      return { i, sha: made.value.body.commit as string, commit_ms: made.ms, land_ms: landed.ms, commit: made.value.status, land: landed.value.status, error: landed.value.body.error?.code };
    }),
  );
  const elapsed = performance.now() - began;

  // Warm bounded reads: one file per reader at the final head.
  const reads = await Promise.all(
    Array.from({ length: WRITERS }, (_, i) => timed(() => api(`${repo}/blob?path=writers/${i}.txt`, owner, {}, local))),
  );

  // Independent model: every writer's file present with its content; one log entry each.
  const tree = await api(`${repo}/tree?path=writers`, owner, {}, local);
  const expected = Array.from({ length: WRITERS }, (_, i) => `${i}.txt`).sort();
  const txlog = await api(`${repo}/txlog?limit=500`, owner, {}, local);
  const kinds = txlog.body.entries.map((e: any) => e.kind);

  // Scion S3: a one-file commit costs about the same in a 100-file and a 10,000-file repo.
  const big = await repoWith(owner, 10_000);
  const edit = (target: string, k: number) =>
    timed(() => api(`/repos/${target}/commits`, owner, { body: { ref: 'main', changes: [file('seed/0/0.txt', `edit ${k}\n`)], message: 'edit', author } }, local));
  for (let k = 0; k < 3; k++) await Promise.all([edit(id, k), edit(big, k)]); // warm both
  const smallSamples: number[] = [];
  const largeSamples: number[] = [];
  for (let k = 3; k < 33; k++) {
    smallSamples.push((await edit(id, k)).ms);
    largeSamples.push((await edit(big, k)).ms);
  }
  const small = latency(smallSamples);
  const large = latency(largeSamples);

  const result = {
    writers: WRITERS,
    elapsed_ms: Math.round(elapsed),
    commits: latency(results.map((r) => r.commit_ms)),
    landings: latency(results.map((r) => r.land_ms)),
    reads: latency(reads.map((r) => r.ms)),
    land_failures: results.filter((r) => r.land !== 200).map((r) => r.error),
    log_entries: kinds.length,
    merges: kinds.filter((k: string) => k === 'merge').length,
    s3_commit_small: small,
    s3_commit_large: large,
  };
  console.log(`YONEDA_PLATFORM_LOAD ${JSON.stringify(result)}`);
  expect(results.every((r) => r.commit === 200)).toBe(true);
  expect(result.land_failures).toEqual([]);
  // S3: commit cost must not grow with repository size. The strict ±20% gate is applied
  // by tools/platform-load.mjs; this bound catches O(history) regressions without flaking.
  expect(large.p50_ms).toBeLessThanOrEqual(small.p50_ms * 2 + 10);
  // N4 gates: commit acceptance and warm bounded reads p95 under 1 s.
  expect(result.commits.p95_ms).toBeLessThan(1000);
  expect(result.reads.p95_ms).toBeLessThan(1000);
  expect(reads.every((r) => r.value.status === 200)).toBe(true);
  expect(reads.map((r) => r.value.body.content)).toEqual(Array.from({ length: WRITERS }, (_, i) => `writer ${i}\n`));
  expect(tree.body.entries.map((e: any) => e.name).sort()).toEqual(expected);
  // Group landing: one log entry per batch, and every writer's commit records a landing.
  expect(kinds[0]).toBe('import');
  expect(kinds.length).toBeLessThanOrEqual(WRITERS + 1);
  const landed = await Promise.all(results.map((r) => api(`${repo}/commits/${r.sha}`, owner, {}, local)));
  expect(landed.every((d) => d.body.landings.length === 1)).toBe(true);
}, 600_000);
