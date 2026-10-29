// Reads of objects still staged in commit shards (accepted, not yet drained to R2) by a
// reader that may not know which commit, and so which shard, staged them. Asking every
// shard for content took one call per shard per 64 objects (store_staged_objects reads at
// most 64), so a pack read of a few hundred undrained objects made hundreds of calls. Now
// every shard is asked once per thousand ids which it holds, and only the holders are read;
// a reader naming each object's commit reads that commit's shard alone; and one request's
// concurrent single reads share their asks.

import { legacyShardOf, SHARDS, shardCall, shardOf } from './repo-shards';
import type { CachedObject, RawObject } from './repo-stores';
import type { Env } from './types';

type Json = Record<string, any>;

/** Ids one shard reads (content) or checks (`store_staged_held`) in one call, and shard
 * calls in flight. */
const READ_IDS = 64;
const HELD_IDS = 1_000;
const SHARD_WIDTH = 64;

type Staged = CachedObject | RawObject;
type Asked = { byId: Map<string, Staged>; failure: unknown };

/** `ids` in pieces of at most `size`. */
const pieces = (ids: string[], size: number) =>
  Array.from({ length: Math.ceil(ids.length / size) }, (_, i) =>
    ids.slice(i * size, (i + 1) * size),
  );

/** Runs shard calls (`[shard, command]`) SHARD_WIDTH at a time; a shard that cannot answer
 * is reported (`failure`), not thrown: one busy shard must not fail reads of objects it does
 * not hold. */
async function eachShard(env: Env, repo: string, calls: [number, Json][], answer: Asked) {
  const out: [number, Json][] = [];
  for (let i = 0; i < calls.length; i += SHARD_WIDTH)
    await Promise.all(
      calls.slice(i, i + SHARD_WIDTH).map(([shard, command]) =>
        shardCall(env, repo, shard, command).then(
          (r) => void out.push([shard, r]),
          (e) => {
            answer.failure ??= e;
          },
        ),
      ),
    );
  return out;
}

/** Staged content of the ids each shard of `asked` holds. */
async function readShards(
  env: Env,
  repo: string,
  asked: Map<number, string[]>,
  raw: boolean,
  answer: Asked = { byId: new Map(), failure: null },
) {
  const calls: [number, Json][] = [];
  for (const [shard, ids] of asked)
    for (const piece of pieces(ids, READ_IDS))
      calls.push([
        shard,
        { op: 'store_staged_objects', ids: piece, ...(raw ? { raw: true } : {}) },
      ]);
  for (const [, r] of await eachShard(env, repo, calls, answer))
    for (const o of r.objects as Staged[]) answer.byId.set(o.id, o);
  return answer;
}

/** Every shard asked which of `ids` it holds (a call per shard per HELD_IDS ids), then the
 * content read from the shards that do: about 64 calls per thousand ids, not per 64. */
async function askEveryShard(env: Env, repo: string, ids: string[], raw: boolean) {
  const answer: Asked = { byId: new Map(), failure: null };
  const probes: [number, Json][] = [];
  for (let shard = 0; shard < SHARDS; shard++)
    for (const piece of pieces(ids, HELD_IDS))
      probes.push([shard, { op: 'store_staged_held', ids: piece }]);
  const holders = new Map<number, string[]>();
  for (const [shard, r] of await eachShard(env, repo, probes, answer))
    if (r.held.length) holders.set(shard, [...(holders.get(shard) ?? []), ...(r.held as string[])]);
  return readShards(env, repo, holders, raw, answer);
}

/** Staged objects of shard commits not yet in R2, from every shard (a rare read path:
 * an object is staged with its commit, whose id the reader does not know), all of `ids`
 * in one ask. A shard that cannot answer fails the call only when an object is found in
 * no other shard. */
export async function stagedInShards(env: Env, repo: string, ids: string[], raw = false) {
  if (!env.COMMIT_SHARDS || ids.length === 0) return [];
  const { byId, failure } = await askEveryShard(env, repo, ids, raw);
  if (failure && ids.some((id) => !byId.has(id))) throw failure;
  return [...byId.values()];
}

/** `stagedInShards` for a reader that knows the commit (`owners`: id → commit) each of
 * some `ids` was staged with: those are asked of their commits' shards, and only what
 * they do not answer of every shard. */
export async function stagedWithCommits(
  env: Env,
  repo: string,
  ids: string[],
  owners: Map<string, string>,
  raw = false,
) {
  if (!env.COMMIT_SHARDS || ids.length === 0) return [];
  // Each commit's shard, then its pre-64-shard one for what that did not answer; an owner's
  // shard that cannot answer leaves its objects to every shard.
  const answer: Asked = { byId: new Map(), failure: null };
  for (const legacy of [false, true]) {
    const asked = new Map<number, string[]>();
    for (const id of ids) {
      const commit = owners.get(id);
      if (!commit || answer.byId.has(id)) continue;
      const shard = legacy ? legacyShardOf(commit) : shardOf(commit);
      if (legacy && shard === shardOf(commit)) continue;
      const list = asked.get(shard) ?? [];
      list.push(id);
      asked.set(shard, list);
    }
    await readShards(env, repo, asked, raw, answer);
  }
  const { byId } = answer;
  const rest = ids.filter((id) => !byId.has(id));
  return [...byId.values(), ...(await stagedInShards(env, repo, rest, raw))];
}

/**
 * One request's single-object asks of every shard (its tiered reads' last resort), shared:
 * while one ask is out, ids that arrive wait for the next, which carries them all, so a
 * request reading many files costs a few asks of the 64 shards, not one per file. Kept
 * per request: an ask's I/O belongs to the request that made it.
 */
export class SharedShardAsk {
  #next: { ids: Set<string>; answer: Promise<Asked> } | null = null;
  #last: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly env: Env,
    private readonly repo: string,
  ) {}

  /** `id`'s staged copy (null when no shard holds it); throws as `stagedInShards` does. */
  async get(id: string): Promise<CachedObject | null> {
    if (!this.env.COMMIT_SHARDS) return null;
    if (!this.#next) {
      const ids = new Set<string>();
      const answer = this.#last.then(() => {
        this.#next = null;
        return askEveryShard(this.env, this.repo, [...ids], false);
      });
      this.#next = { ids, answer };
      this.#last = answer.catch(() => {});
    }
    const batch = this.#next;
    batch.ids.add(id);
    const { byId, failure } = await batch.answer;
    const found = byId.get(id);
    if (!found && failure) throw failure;
    return (found as CachedObject | undefined) ?? null;
  }
}
