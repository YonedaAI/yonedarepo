// Commit shards: commits built by stateless compute are recorded in one of a few small
// Durable Objects chosen by commit id, so concurrent writers spread out instead of
// queueing on the repository authority. A commit id names its shard, so any Worker reads
// it back at once. The authority adopts a commit (parents first) when it first needs it.
import type { CachedObject, RawObject } from './repo-stores';
import type { Env } from './types';

type Json = Record<string, any>;
export const SHARDS = 16;
const SYSTEM = { _system: 'commits' };
const NOT_RECORDED = /Commit ([0-9a-f]{40}) is not recorded/;
const ADOPT_DEPTH = 256;

export const shardOf = (commit: string) => Number.parseInt(commit[0], 16) % SHARDS;

function fail(error: { code: string; message: string }) {
  return Object.assign(new Error(error.message), { code: error.code });
}

/** One command against shard `shard` of `repo`. */
export async function shardCall(env: Env, repo: string, shard: number, command: Json) {
  const namespace = env.COMMIT_SHARDS as DurableObjectNamespace;
  const stub = namespace.get(namespace.idFromName(`${repo}:${shard}`));
  const response = await stub.fetch('https://commit-shard/', {
    method: 'POST',
    body: JSON.stringify({ ...command, ...SYSTEM }),
  });
  const value = await response.json<Json>();
  if (value.error) throw fail(value.error);
  return value;
}

async function authority(env: Env, repo: string, command: Json) {
  const stub = env.SOURCE_REPOS.get(env.SOURCE_REPOS.idFromName(repo));
  const response = await stub.fetch('https://source-repository/', {
    method: 'POST',
    body: JSON.stringify({ ...command, ...SYSTEM }),
  });
  return response.json<Json>();
}

/** A shard's record of `commit`, or null if no shard holds it. */
export async function shardRecord(env: Env, repo: string, commit: string) {
  if (!env.COMMIT_SHARDS) return null;
  return shardCall(env, repo, shardOf(commit), { op: 'store_commit', commit }).catch((e) => {
    if (e?.code === 'NOT_FOUND') return null;
    throw e;
  });
}

/**
 * Copies `commit` (and any unadopted ancestors, parents first) from its shard into the
 * authority. Returns false when no shard holds it.
 */
export async function adoptCommit(env: Env, repo: string, commit: string) {
  const pending = [commit];
  for (let step = 0; pending.length > 0 && step < ADOPT_DEPTH; step++) {
    const id = pending[pending.length - 1];
    const record = await shardRecord(env, repo, id);
    if (!record) return false;
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

/** Staged objects of shard commits not yet in R2, from every shard (a rare read path). */
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
