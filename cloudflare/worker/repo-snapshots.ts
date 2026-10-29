// Reads answered from published or immutable data, so a burst of readers never queues on
// the repository's authority: access from main's published head (repo-head.ts), a commit's
// tree from the object tiers (commits are content-addressed), main at a version the head
// covers from the head, any other pinned version from an immutable snapshot cache, and refs
// from a snapshot the head holder keeps. What those cannot answer goes to the authority.
//
// Refs are a snapshot: a reader sees refs read from the authority at most 2 x `REFS_MS`
// earlier (the holder's copy, then this isolate's), never older than a version this
// isolate already served, and never older than this isolate's own ref writes. A reader that
// must see a write made elsewhere passes its version as `min_version`.
import { rpcValue } from './durable';
import { readFromHead } from './repo-head';
import { ApiError, caller, type Json, type RepoContext, target, writesTo } from './repo-ops';
import type { Env } from './types';

export const REFS_MS = 1000;
const SHA = /^[0-9a-f]{40}$/;
const PINNED_ORIGIN = 'https://snapshots.yoneda.internal';
/** Platform reads made on behalf of callers the published head already authorized. */
const platform = (env: Env, repo: string) => caller(env, repo, { _system: 'projection' });

const loading = new Map<string, Promise<Json>>();
/** One load per key at a time in this isolate; concurrent callers share it. */
function once(key: string, load: () => Promise<Json>) {
  let pending = loading.get(key);
  if (!pending) {
    pending = load().finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/** The caller's read access and main's published head, as `readFromHead`; null also when
 * main does not exist yet (an empty repository has no published head). */
export async function headAccess(ctx: RepoContext, minVersion = 0) {
  return readFromHead(ctx, minVersion).catch((e) => {
    if (e?.code === 'NOT_FOUND') return null;
    throw e;
  });
}

/** Authorizes this request's reads from the published head's access snapshot and returns
 * the head, or null when the authority must decide (it then does, on `ctx.status()`). */
export async function authorizeRead(ctx: RepoContext, minVersion = 0): Promise<Json | null> {
  const fromHead = await headAccess(ctx, minVersion);
  if (!fromHead) return null;
  ctx.authorize(fromHead.head, fromHead.access);
  return fromHead.head;
}

/**
 * An answer that never changes (a pinned version's snapshot or refs), shared through the
 * Cache API. Only for callers already authorized: the answer is the same for every reader
 * (neither op redacts by grant).
 */
async function pinned(env: Env, repo: string, command: Json): Promise<Json> {
  const key = `${PINNED_ORIGIN}/${repo}/${command.op}/${encodeURIComponent(command.ref ?? '')}/${command.at}`;
  return once(key, async () => {
    const hit = await caches.default.match(key).catch(() => undefined);
    if (hit) return hit.json<Json>();
    const value = await platform(env, repo)(command);
    await caches.default
      .put(
        key,
        Response.json(value, {
          headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        }),
      )
      .catch(() => {
        // An optimization: the authority answers again on a miss.
      });
    return value;
  });
}

const isMain = (spec: unknown) =>
  [undefined, null, '', 'main', 'refs/heads/main'].includes(spec as string);
const versionOf = (at: unknown) =>
  at === undefined || at === null || at === '' ? null : Number(at);

/**
 * The commit and tree a read at `spec` (a commit id or branch, default main) and version
 * `at` (default: now) walks. The caller is authorized first (`ctx.status()` passed); `head`
 * is main's published head when it authorized the read.
 */
export async function readTarget(
  ctx: RepoContext,
  head: Json | null,
  spec: string | undefined,
  at: unknown,
): Promise<Json> {
  const version = versionOf(at);
  if (spec && SHA.test(spec)) {
    // Commits are immutable and keyed per repository: an id this repository's store does
    // not hold falls through to the authority (a commit only its shard has recorded yet).
    const objects = await ctx.objects();
    const header = await objects.object(spec, 'commit').catch((e) => {
      if (e?.code === 'NOT_FOUND') return null;
      throw e;
    });
    if (header?.kind === 'commit') return { commit: spec, tree: header.tree };
    return target(ctx, spec, at);
  }
  if (isMain(spec) && head && coversMain(head, version))
    return { commit: head.head.id, tree: head.head.tree };
  if (version !== null && Number.isSafeInteger(version) && version >= 0)
    return pinned(ctx.env, ctx.repo, { op: 'repo_snapshot', ref: spec || 'main', at: version });
  return target(ctx, spec, at);
}

/** Whether main at `version` (null: now) is the head's projected commit: no changeset
 * waits at or before it, and main has not moved since the head's projection. */
function coversMain(head: Json, version: number | null) {
  const pending = head.overlay as Json[];
  if (version === null) return pending.length === 0;
  return (
    Number.isSafeInteger(version) &&
    version >= Number(head.projected_version) &&
    version <= head.version &&
    pending.every((c) => c.version > version)
  );
}

type HeldRefs = { refs: Json; at: number; writes: number };
/** Per repository: this isolate's refs snapshot, with this isolate's ref-write count when
 * it was taken, and the newest version this isolate has served. */
const refsSnapshots = new Map<string, HeldRefs>();
const servedVersions = new Map<string, number>();

type Holder = { refs(repo: string, minVersion: number): Promise<Json> };
function holder(env: Env, repo: string): Holder | null {
  const namespace = env.LAND_COMBINERS;
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName(`${repo}#head`)) as unknown as Partial<Holder>;
  return typeof stub.refs === 'function' ? (stub as Holder) : null;
}

/** `git_refs`: every ref, now (a snapshot, see above) or at version `at` (exact). A current
 * read that still finds refs waiting for the projector after the retries (a lagging
 * projector) answers every other ref, naming the waiting ones in `pending`. */
export async function readRefs(ctx: RepoContext, args: Json) {
  try {
    return await readAllRefs(ctx, args);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'PROJECTION_PENDING') || versionOf(args.at) !== null)
      throw e;
    return ctx.call({ op: 'repo_refs', partial: true });
  }
}

async function readAllRefs(ctx: RepoContext, args: Json) {
  const at = versionOf(args.at);
  const head = await authorizeRead(ctx);
  if (!head) return ctx.call({ op: 'repo_refs', ...(at === null ? {} : { at }) });
  if (at !== null) {
    if (!Number.isSafeInteger(at) || at < 0)
      throw new ApiError('INVALID_INPUT', 'at must be a version number');
    return pinned(ctx.env, ctx.repo, { op: 'repo_refs', at });
  }
  const minVersion = Number(args.min_version ?? 0);
  const refs = await refsSnapshot(
    ctx.env,
    ctx.repo,
    Number.isSafeInteger(minVersion) ? minVersion : 0,
  );
  if (refs.version < minVersion)
    throw new ApiError(
      'STALE_READ',
      `The repository has not reached version ${minVersion} yet; retry`,
    );
  return refs;
}

async function refsSnapshot(env: Env, repo: string, minVersion: number): Promise<Json> {
  const writes = writesTo(repo);
  const held = refsSnapshots.get(repo);
  if (
    held &&
    held.writes === writes &&
    Date.now() - held.at < REFS_MS &&
    held.refs.version >= minVersion
  )
    return held.refs;
  const started = Date.now();
  // After this isolate wrote, a shared snapshot may predate the write: read the authority.
  const wrote = held ? held.writes !== writes : writes > 0;
  const shared = wrote ? null : holder(env, repo);
  const floor = Math.max(minVersion, servedVersions.get(repo) ?? 0);
  let refs = shared ? await once(`refs:${repo}`, () => rpcValue(shared.refs(repo, floor))) : null;
  if (!refs || refs.version < floor)
    refs = await once(`refs:${repo}:${writes}`, () => platform(env, repo)({ op: 'repo_refs' }));
  servedVersions.set(repo, Math.max(refs.version, servedVersions.get(repo) ?? 0));
  const current = refsSnapshots.get(repo);
  if (!current || current.refs.version <= refs.version)
    refsSnapshots.set(repo, { refs, at: started, writes });
  return refs;
}

/** The head holder's refs role: one authority read per `REFS_MS` at most, shared by every
 * isolate's readers. */
export class RefsHolder {
  #refs: { value: Json; at: number } | null = null;
  #loading: Promise<Json> | null = null;

  constructor(private readonly env: Env) {}

  async refs(repo: string, minVersion: number): Promise<Json> {
    const held = this.#refs;
    if (held && Date.now() - held.at < REFS_MS && held.value.version >= minVersion)
      return held.value;
    let value: Json = held?.value ?? {};
    for (let attempt = 0; attempt < 2; attempt++) {
      // A load already running may have started before the version this caller needs.
      this.#loading ??= this.#load(repo);
      value = await this.#loading;
      if (value.version >= minVersion) break;
    }
    return value;
  }

  /** Refs moved (a landing, projection or access change): the next reader reloads. */
  forget() {
    this.#refs = null;
    this.#loading = null;
  }

  #load(repo: string): Promise<Json> {
    const started = Date.now();
    const load: Promise<Json> = platform(
      this.env,
      repo,
    )({ op: 'repo_refs' })
      .then((value) => {
        if (this.#loading === load) this.#refs = { value, at: started };
        return value;
      })
      .finally(() => {
        if (this.#loading === load) this.#loading = null;
      });
    return load;
  }
}
