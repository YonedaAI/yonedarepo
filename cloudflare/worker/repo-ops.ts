// Source platform operations shared by the HTTP API and MCP. Each takes plain arguments
// and returns JSON; the SourceRepository Durable Object and Rust compute decide, this
// module only moves objects between the cache tiers and those deciders.
import { durableJson } from './durable';
import type { OrgAccess } from './platform-org-access';
import { archivedObjects } from './repo-archive';
import { awaitProjection } from './repo-changesets';
import { compute } from './repo-compute';
import { decide, keepAllowed, outside } from './repo-grants';
import { guardInherited } from './repo-inherit';
import {
  type CachedObject,
  parseStore,
  RepoObjects,
  type TreeEntry,
  toBase64,
} from './repo-objects';
import type { PatGrant } from './repo-pat';
import { adoptCommit, unrecorded } from './repo-shards';
import { timed } from './repo-timing';
import type { Env } from './types';

export type { PatGrant, PatScope } from './repo-pat';

export type Json = Record<string, any>;
export type Credentials =
  | { _session: { workspace: string; principal: string; human?: true; orgs?: OrgAccess } }
  | { _token: string }
  /** A personal access token the adapter verified (repo-pat.ts). */
  | { _pat: PatGrant }
  | {
      _system:
        | 'checks'
        | 'projection'
        | 'import'
        | 'merge'
        | 'repair'
        | 'derive'
        | 'commits'
        | 'purge'
        | 'hooks'
        | 'compact'
        | 'fork';
    };
// Identity fields come only from the authenticating adapter, never from arguments.
const CREDENTIAL_KEYS = ['_session', '_token', '_pat', '_system'];
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Json,
  ) {
    super(message);
  }
}

/** Commands that never move a ref (reads, and commits before they land). Any other
 * command a caller in this isolate sends may, so refs snapshots taken before it are not
 * served to this isolate (repo-snapshots.ts). */
const KEEPS_REFS = new Set([
  'repo_prepare_commit',
  'repo_begin_commit',
  'repo_record_commit',
  'repo_adopt_commit',
  'repo_check_request',
  'repo_session_record',
  'repo_status',
  'repo_refs',
  'repo_snapshot',
  'repo_log',
  'repo_txlog',
  'repo_commit',
  'repo_merge_base',
  'repo_path_history',
  'repo_contracts',
  'repo_head',
  'repo_staged_objects',
  'repo_tokens',
  'repo_members',
  'repo_land_status',
  'repo_git_access',
  'repo_git_walk',
  'repo_clone_access',
  'repo_compact_plan',
  'repo_compact_done',
  'repo_set_retention',
]);
const writes = new Map<string, number>();
/** How many commands that may move refs this isolate has sent to `repo`. */
export const writesTo = (repo: string) => writes.get(repo) ?? 0;
/** Notes one (a landing or merge settled elsewhere for this isolate counts too). */
export const noteWrite = (repo: string) => void writes.set(repo, writesTo(repo) + 1);

export type Call = ((command: Json) => Promise<Json>) & {
  /** The command as this caller sends it (credentials attached), for `batch`. */
  sign(command: Json): Json;
};
export function caller(env: Env, repo: string, auth: Credentials): Call {
  const stub = () => env.SOURCE_REPOS.get(env.SOURCE_REPOS.idFromName(repo));
  const sign = (command: Json) => {
    // A personal token's repository allowlist holds on every path that signs a command:
    // REST, MCP, batches and decisions from the published head.
    if ('_pat' in auth && auth._pat.repos !== null && !auth._pat.repos.includes(repo))
      throw new ApiError('FORBIDDEN', 'This token is not allowed on this repository');
    return {
      ...Object.fromEntries(Object.entries(command).filter(([k]) => !CREDENTIAL_KEYS.includes(k))),
      ...auth,
    };
  };
  const once = async (command: Json) => {
    const value = await timed(`do.${command.op}`, () =>
      durableJson<Json>(stub, 'https://source-repository/', JSON.stringify(sign(command))),
    ).finally(() => {
      // Counted when it settles (it may have committed even if its answer was lost).
      if (!KEEPS_REFS.has(command.op)) noteWrite(repo);
    });
    if (value.error) throw new ApiError(value.error.code, value.error.message);
    return value;
  };
  // A commit the authority has not seen may live in its commit shard: adopt, then retry.
  // A read at the latest version of a branch with unprojected changesets waits for them.
  // A read below the compaction floor is retried once with the archived log it names.
  const call = async (command: Json) => {
    let sent = command;
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(sent);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'TXLOG_ARCHIVED' && !sent._archive) {
          const archive = await archivedObjects(env, repo, e.message);
          if (archive) {
            sent = { ...sent, _archive: archive };
            continue;
          }
        }
        if (e instanceof ApiError && e.code === 'PROJECTION_PENDING' && attempt < 4) {
          await awaitProjection(env, repo);
          continue;
        }
        const missing = unrecorded(e);
        if (!missing || attempt >= 4) throw e;
        // False also when a racing adoption took it first: retry once in case.
        if (!(await timed('adopt', () => adoptCommit(env, repo, missing))) && attempt > 0) throw e;
      }
    }
  };
  return Object.assign(call, { sign });
}

/** Signed commands (possibly of different callers) in one round trip to the authority,
 * each in its own transaction; a failed one answers `{error}` without stopping the rest. */
export async function batch(env: Env, repo: string, commands: Json[]): Promise<Json[]> {
  const stub = () => env.SOURCE_REPOS.get(env.SOURCE_REPOS.idFromName(repo));
  return timed(`do.${commands.map((c) => c.op).join('+')}`, () =>
    durableJson<Json[]>(stub, 'https://source-repository/batch', JSON.stringify(commands)),
  ).finally(() => {
    if (commands.some((c) => !KEEPS_REFS.has(c.op))) noteWrite(repo);
  });
}

/** One repository, as seen by one authenticated caller. */
export class RepoContext {
  private statusOnce?: Promise<Json>;
  /** Main's published head, when this request reads from it instead of the authority. */
  published?: Json;
  constructor(
    readonly env: Env,
    readonly repo: string,
    readonly call: Call,
    private cached?: RepoObjects,
  ) {}
  /** The caller's view of the repository (including its grant), read once per request. */
  status() {
    this.statusOnce ??= this.call({ op: 'repo_status' });
    return this.statusOnce;
  }
  /** Serves this request's access and main's head from the published head. */
  publish(head: Json, access: Json) {
    this.published = head;
    this.authorize(head, access);
  }
  /** Serves this request's access (grant and object store) from the published head's
   * access snapshot; reads elsewhere than main's head use it too. */
  authorize(head: Json, access: Json) {
    this.statusOnce = Promise.resolve({ object_store: head.object_store, ...access });
  }
  async objects() {
    if (!this.cached) {
      const status = await this.status();
      this.adopt(status.object_store);
    }
    return this.cached as RepoObjects;
  }
  /** Uses the store an authorized answer named, sparing a status read. */
  adopt(spec: string) {
    this.cached ??= new RepoObjects(this.env, this.repo, parseStore(this.env, spec));
    return this.cached;
  }
}

const SHA = /^[0-9a-f]{40}$/;
const at = (value: unknown) =>
  value === undefined || value === null || value === '' ? {} : { at: Number(value) };

/** A commit id, or a branch name resolved at version `at` (default: now): its commit,
 * tree and parents (and the version, for a branch), in one authority call. */
export async function target(ctx: RepoContext, spec: string | undefined, version?: unknown) {
  if (spec && SHA.test(spec)) return ctx.call({ op: 'repo_commit', commit: spec, brief: true });
  return ctx.call({ op: 'repo_snapshot', ref: spec || 'main', ...at(version) });
}

export async function walk(objects: RepoObjects, tree: string, path: string) {
  let entry: TreeEntry = { name: '', type: 'tree', id: tree };
  for (const part of path.split('/').filter(Boolean)) {
    if (entry.type !== 'tree') throw new ApiError('NOT_FOUND', `${path} is not a directory`);
    const next = (await objects.tree(entry.id)).find((e) => e.name === part);
    if (!next) throw new ApiError('NOT_FOUND', `${path} does not exist`);
    entry = next;
  }
  return entry;
}

/** Runs a Rust compute op that walks trees, supplying the trees it asks for (from
 * `known` when already in hand, else through the tiers). */
export async function withTrees(
  objects: RepoObjects,
  input: Json,
  known: Map<string, CachedObject> = new Map(),
) {
  const trees: Record<string, TreeEntry[]> = {};
  for (let round = 0; round <= 64; round++) {
    const result = compute({ ...input, trees });
    if (!result.need_trees) return result;
    await Promise.all(
      (result.need_trees as string[]).map(async (id) => {
        const held = known.get(id);
        trees[id] = held?.kind === 'tree' ? held.entries : await objects.tree(id);
      }),
    );
  }
  throw new ApiError('INVALID_INPUT', 'Paths are nested too deeply');
}

const OBJECT_BUDGET = 8 * 1024 * 1024;
const OBJECT_KINDS = ['tree', 'blob', 'commit'];

/**
 * A path-restricted caller may fetch only objects it can name by path inside its grant at
 * a commit (no lookups by bare id, which would be a content oracle). Commit objects carry
 * only ids and are allowed.
 */
async function authorizeObjects(ctx: RepoContext, wanted: Json[], commitId: unknown) {
  if (!SHA.test(String(commitId ?? '')))
    throw new ApiError('FORBIDDEN', 'Path-restricted callers fetch objects by commit and path');
  const where = await ctx.call({ op: 'repo_commit', commit: commitId });
  const objects = await ctx.objects();
  for (const object of wanted) {
    if (object.kind === 'commit') continue;
    const path = String(object.path ?? '');
    if (!path || !(await decide(ctx, [path])).paths[0]) throw outside();
    const entry = await walk(objects, where.tree, path).catch(() => null);
    const kind = entry?.type === 'tree' ? 'tree' : 'blob';
    if (!entry || entry.id !== object.id || kind !== object.kind) throw outside();
  }
}

/**
 * Batch, resumable object fetch (Scion GetObjects): immutable objects by id and kind, in
 * request order, up to a response budget. `next` resumes after the last object served,
 * so an interrupted client never refetches what it already has.
 */
export async function getObjects(ctx: RepoContext, args: Json) {
  const wanted = args.objects;
  if (
    !Array.isArray(wanted) ||
    wanted.length === 0 ||
    wanted.length > 10_000 ||
    !wanted.every((o) => SHA.test(o?.id) && OBJECT_KINDS.includes(o?.kind))
  )
    throw new ApiError('INVALID_INPUT', 'objects must be 1-10000 {id, kind} entries');
  const start = Number(args.after ?? 0);
  if (!Number.isSafeInteger(start) || start < 0 || start > wanted.length)
    throw new ApiError('INVALID_INPUT', 'after is outside the request');
  const objects = await ctx.objects();
  // Ids named by the caller: a fork serves inherited ones only to readers of its parent.
  guardInherited(ctx, objects);
  const grant = await decide(ctx, []);
  if (grant.restricted) await authorizeObjects(ctx, wanted, args.commit);
  // `raw`: commits as their exact Git content (`data_b64`) from the store of record, so a
  // client writes the platform's commit byte for byte. A commit only the object store
  // holds (imported history) keeps the tree-and-parents form. Path-restricted callers get
  // that form too: a message may name paths outside their grant.
  const raw = args.raw === true && !grant.restricted;
  const served: Json[] = [];
  const missing: string[] = [];
  let bytes = 0;
  let index = start;
  while (index < wanted.length) {
    const batch = wanted.slice(index, index + 16);
    const commits = raw ? batch.filter((o: Json) => o.kind === 'commit') : [];
    const exact = new Map(
      (commits.length ? await objects.raw(commits) : [])
        .filter((o) => o.kind === 'commit')
        .map((o) => [o.id, o]),
    );
    const read = await Promise.all(
      batch.map((o: Json) =>
        o.kind === 'commit' && exact.has(o.id)
          ? exact.get(o.id)
          : objects.object(o.id, o.kind).catch((e) => {
              if (e?.code === 'NOT_FOUND') return null;
              throw e;
            }),
      ),
    );
    let stop = false;
    for (const [offset, object] of read.entries()) {
      if (!object) missing.push(batch[offset].id);
      else {
        const size = JSON.stringify(object).length;
        if (served.length > 0 && bytes + size > OBJECT_BUDGET) {
          stop = true;
          break;
        }
        bytes += size;
        served.push(object);
      }
      index++;
    }
    if (stop) break;
  }
  return {
    objects: served,
    missing,
    next: index < wanted.length ? index : null,
    tiers: objects.hits,
  };
}

const PATCH_FILES = 200;
const PATCH_BYTES = 16 * 1024 * 1024;

/** `head` against `base` (default: head's first parent; or their merge base). */
export async function diff(ctx: RepoContext, args: Json) {
  const head = await target(ctx, args.head, args.at);
  let base: Json | null = null;
  if (args.base) {
    base = await target(ctx, args.base, args.at);
    if (args.merge_base) {
      const found = await ctx.call({
        op: 'repo_merge_base',
        left: base.commit,
        right: head.commit,
      });
      base = found.merge_bases[0] ?? null;
    }
  } else if (head.parents[0]) base = await ctx.call({ op: 'repo_commit', commit: head.parents[0] });
  const objects = await ctx.objects();
  let changes: Json[] = (
    await withTrees(objects, { op: 'tree_diff', old: base?.tree ?? null, new: head.tree })
  ).changes;
  changes = (await keepAllowed(ctx, changes)).map((c) => ({ ...c }));
  for (const change of changes)
    if (change.old_path && !(await decide(ctx, [change.old_path])).paths[0]) delete change.old_path;
  const prefix = String(args.path ?? '');
  if (prefix)
    changes = changes.filter(
      (c) => c.path === prefix || c.path.startsWith(`${prefix.replace(/\/$/, '')}/`),
    );
  if (args.patch) {
    let budget = PATCH_BYTES;
    for (const change of changes.slice(0, PATCH_FILES)) {
      const files = [change.old, change.new].filter((s) => s && ['blob', 'exec'].includes(s.type));
      if (files.length === 0) continue;
      const input: Json = { op: 'file_patch' };
      for (const [side, value] of [
        ['old', change.old],
        ['new', change.new],
      ] as const) {
        if (!value || !['blob', 'exec'].includes(value.type)) continue;
        const bytes = await objects.blob(value.id);
        budget -= bytes.length;
        input[`${side}_id`] = value.id;
        input[`${side}_b64`] = toBase64(bytes);
      }
      if (budget < 0) {
        change.patch_omitted = 'budget';
        break;
      }
      Object.assign(change, compute(input));
    }
  }
  return {
    base: base ? { commit: base.commit, tree: base.tree } : null,
    head: { commit: head.commit, tree: head.tree },
    changes,
  };
}
