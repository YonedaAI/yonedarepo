// Commit shards: commits built by stateless compute are recorded in one of a few small
// Durable Objects chosen by commit id, so concurrent writers spread out instead of
// queueing on the repository authority. A commit id names its shard, so any Worker reads
// it back at once. The authority adopts a commit (parents first) when it first needs it.
import { durableJson } from './durable';
import type { CachedObject, RawObject } from './repo-stores';
import type { Env } from './types';

type Json = Record<string, any>;
/** 64 shards: a 1000-writer burst puts ~16 commits on each. */
export const SHARDS = 64;
/** Commits recorded before 64 shards sit in the shard of their first hex digit. */
const LEGACY_SHARDS = 16;
const SYSTEM = { _system: 'commits' };
const NOT_RECORDED = /Commit ([0-9a-f]{40}) is not recorded/;
const ADOPT_DEPTH = 256;

export const shardOf = (commit: string) => Number.parseInt(commit.slice(0, 2), 16) % SHARDS;
/** The shards that may hold `commit`: where it is written now, then where it was. */
const shardsOf = (commit: string) => [
  ...new Set([shardOf(commit), Number.parseInt(commit[0], 16) % LEGACY_SHARDS]),
];

function fail(error: { code: string; message: string }) {
  return Object.assign(new Error(error.message), { code: error.code });
}

/** One command against shard `shard` of `repo`. */
export async function shardCall(env: Env, repo: string, shard: number, command: Json) {
  const namespace = env.COMMIT_SHARDS as DurableObjectNamespace;
  const stub = () => namespace.get(namespace.idFromName(`${repo}:${shard}`));
  const value = await durableJson(
    stub,
    'https://commit-shard/',
    JSON.stringify({ ...command, ...SYSTEM }),
  );
  if (value.error) throw fail(value.error);
  return value;
}

async function authority(env: Env, repo: string, command: Json) {
  const stub = () => env.SOURCE_REPOS.get(env.SOURCE_REPOS.idFromName(repo));
  return durableJson(stub, 'https://source-repository/', JSON.stringify({ ...command, ...SYSTEM }));
}

/** A shard's record of `commit`, or null if no shard holds it. */
export async function shardRecord(env: Env, repo: string, commit: string) {
  if (!env.COMMIT_SHARDS) return null;
  for (const shard of shardsOf(commit)) {
    const record = await shardCall(env, repo, shard, { op: 'store_commit', commit }).catch((e) => {
      if (e?.code === 'NOT_FOUND') return null;
      throw e;
    });
    if (record) return record;
  }
  return null;
}

/**
 * Copies `commit` and its unadopted ancestors into the authority in one call, parents
 * first, then drops their shard records: the walk down the chain stops at the first
 * commit no shard holds (adopted earlier, or the authority's own). Returns false when no
 * shard holds `commit`. Idempotent: a racing or repeated adoption finds them adopted.
 */
export async function adoptCommit(env: Env, repo: string, commit: string) {
  const chain = await shardChain(env, repo, commit);
  if (chain.length === 0) return false;
  const adopted = await authority(env, repo, { op: 'repo_adopt_commit', records: chain });
  if (adopted.error) {
    // An ancestor's record went missing mid-walk (another adoption forgot it): one by one.
    if (!NOT_RECORDED.test(adopted.error.message)) throw fail(adopted.error);
    return adoptStepwise(env, repo, commit);
  }
  await forgetChain(env, repo, chain);
  return true;
}

/** `commit` and its ancestors still held by shards, parents first (empty when none). */
export async function shardChain(env: Env, repo: string, commit: string) {
  const chain: Json[] = [];
  for (let id: string | undefined = commit; id && chain.length < ADOPT_DEPTH; ) {
    const record = await shardRecord(env, repo, id);
    if (!record) break;
    chain.push(record);
    id = JSON.parse(record.commit.parents)[0];
  }
  return chain.reverse();
}

/** Drops the shard records of an adopted chain, so the next walk stops before it. */
export async function forgetChain(env: Env, repo: string, chain: Json[]) {
  const byShard = new Map<number, string[]>();
  for (const r of chain)
    for (const shard of shardsOf(r.commit.id))
      byShard.set(shard, [...(byShard.get(shard) ?? []), r.commit.id]);
  await Promise.all(
    [...byShard].map(([shard, ids]) => shardCall(env, repo, shard, { op: 'store_forget', ids })),
  );
}

async function adoptStepwise(env: Env, repo: string, commit: string) {
  const pending = [commit];
  for (let step = 0; pending.length > 0 && step < ADOPT_DEPTH; step++) {
    const id = pending[pending.length - 1];
    const record = await shardRecord(env, repo, id);
    // Gone from its shard after an adoption raced ahead: the authority has it now.
    if (!record) {
      pending.pop();
      continue;
    }
    const adopted = await authority(env, repo, { op: 'repo_adopt_commit', record });
    const missing = adopted.error && NOT_RECORDED.exec(adopted.error.message)?.[1];
    if (missing && missing !== id) pending.push(missing);
    else if (adopted.error) throw fail(adopted.error);
    else pending.pop();
  }
  return pending.length === 0;
}

/** The commit an authority error says it has not recorded, if any. */
export const unrecorded = (e: unknown) =>
  (e as { code?: string })?.code === 'NOT_FOUND'
    ? (NOT_RECORDED.exec(String((e as Error).message))?.[1] ?? null)
    : null;

/** Staged objects of shard commits not yet in R2, from every shard (a rare read path:
 * an object is staged with its commit, whose id the reader does not know). */
export async function stagedInShards(env: Env, repo: string, ids: string[], raw = false) {
  if (!env.COMMIT_SHARDS || ids.length === 0) return [];
  const found = await Promise.all(
    Array.from({ length: SHARDS }, (_, shard) =>
      shardCall(env, repo, shard, {
        op: 'store_staged_objects',
        ids,
        ...(raw ? { raw: true } : {}),
      }).then((r) => r.objects as (CachedObject | RawObject)[]),
    ),
  );
  const byId = new Map(found.flat().map((o) => [o.id, o]));
  return [...byId.values()];
}

/** Every shard's object outbox (for repository status). */
export function shardOutboxes(env: Env, repo: string): Promise<Json[]> {
  if (!env.COMMIT_SHARDS) return Promise.resolve([]);
  return Promise.all(
    Array.from({ length: SHARDS }, (_, shard) =>
      shardCall(env, repo, shard, { op: 'store_status' }),
    ),
  );
}

/** One view of several outboxes: total pending and the oldest entry. */
export function mergeOutboxes(outboxes: Json[]) {
  const oldest = outboxes
    .map((o) => o?.oldest)
    .filter(Boolean)
    .sort((a, b) => a.recorded_at - b.recorded_at)[0];
  return {
    pending: outboxes.reduce((n, o) => n + (o?.pending ?? 0), 0),
    oldest: oldest ?? null,
  };
}

/** Every staged object of `commit` from its shard (none once R2 holds them). */
export async function shardStagedOf(
  env: Env,
  repo: string,
  commit: string,
): Promise<CachedObject[]> {
  return (await shardLanded(env, repo, commit, false)).objects;
}

/**
 * `commit`'s staged objects and, with `withRecord`, its shard record (null when no shard
 * holds it), in one call per shard: a commit's record and objects live in the same shard.
 */
export async function shardLanded(
  env: Env,
  repo: string,
  commit: string,
  withRecord: boolean,
): Promise<{ objects: CachedObject[]; record: Json | null }> {
  if (!env.COMMIT_SHARDS) return { objects: [], record: null };
  for (const shard of shardsOf(commit)) {
    const found: Json = await shardCall(env, repo, shard, {
      op: 'store_staged_objects',
      commit,
      ...(withRecord ? { with_record: true } : {}),
    }).catch(() => ({ objects: [] }));
    if (found.objects.length || found.record)
      return { objects: found.objects as CachedObject[], record: found.record ?? null };
  }
  return { objects: [], record: null };
}
