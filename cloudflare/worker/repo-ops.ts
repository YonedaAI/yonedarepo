// Source platform operations shared by the HTTP API and MCP. Each takes plain arguments
// and returns JSON; the SourceRepository Durable Object and Rust compute decide, this
// module only moves objects between the cache tiers and those deciders.
import { compute } from './repo-compute';
import {
  type CachedObject,
  fromBase64,
  RepoObjects,
  type TreeEntry,
  toBase64,
} from './repo-objects';
import type { Env } from './types';

export type Json = Record<string, any>;
export type Credentials =
  | { _session: { workspace: string; principal: string } }
  | { _token: string };
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Call = (command: Json) => Promise<Json>;
export function caller(env: Env, repo: string, auth: Credentials): Call {
  const stub = env.SOURCE_REPOS.get(env.SOURCE_REPOS.idFromName(repo));
  return async (command) => {
    const result = await stub.fetch('https://source-repository/', {
      method: 'POST',
      body: JSON.stringify({ ...command, ...auth }),
    });
    const value = await result.json<Json>();
    if (value.error) throw new ApiError(value.error.code, value.error.message);
    return value;
  };
}

/** One repository, as seen by one authenticated caller. */
export class RepoContext {
  private cached?: RepoObjects;
  constructor(
    readonly env: Env,
    readonly repo: string,
    readonly call: Call,
  ) {}
  async objects() {
    if (!this.cached) {
      const status = await this.call({ op: 'repo_status' });
      this.cached = new RepoObjects(
        this.env,
        this.repo,
        RepoObjects.parseStore(this.env, status.object_store),
      );
    }
    return this.cached;
  }
}

const SHA = /^[0-9a-f]{40}$/;
const at = (value: unknown) =>
  value === undefined || value === null || value === '' ? {} : { at: Number(value) };

/** A commit id, or a branch name resolved at version `at` (default: now). */
export async function target(ctx: RepoContext, spec: string | undefined, version?: unknown) {
  if (spec && SHA.test(spec)) return ctx.call({ op: 'repo_commit', commit: spec });
  const snapshot = await ctx.call({ op: 'repo_snapshot', ref: spec || 'main', ...at(version) });
  return { ...snapshot, ...(await ctx.call({ op: 'repo_commit', commit: snapshot.commit })) };
}

/** Prepare (answering tree requests), push, read back from the store, record. */
export async function commit(ctx: RepoContext, objects: RepoObjects, body: Json) {
  let { parent, base_version } = body;
  if (!parent && body.ref) {
    const snapshot = await ctx.call({ op: 'repo_snapshot', ref: body.ref });
    parent = snapshot.commit;
    base_version = snapshot.version;
  }
  const trees: Record<string, TreeEntry[]> = {};
  for (let round = 0; round < 64; round++) {
    const prepared = await ctx.call({
      op: 'repo_prepare_commit',
      parent: parent ?? null,
      base_version: base_version ?? 0,
      changes: body.changes,
      message: body.message,
      author: body.author,
      read_set: body.read_set ?? [],
      trees,
    });
    if (prepared.need_trees) {
      for (const id of prepared.need_trees as string[]) trees[id] = await objects.tree(id);
      continue;
    }
    const report = await objects.push(fromBase64(prepared.push_b64));
    await objects.cache(prepared.objects as CachedObject[]);
    const readback = await objects.readback(prepared.commit);
    await ctx.call({
      op: 'repo_record_commit',
      commit: prepared.commit,
      push_report_b64: toBase64(report),
      readback,
    });
    return {
      commit: prepared.commit,
      tree: prepared.tree,
      parents: prepared.parents,
      touches: prepared.touches,
      base_version: base_version ?? 0,
    };
  }
  throw new ApiError('INVALID_INPUT', 'Paths are nested too deeply');
}

async function walk(objects: RepoObjects, tree: string, path: string) {
  let entry: TreeEntry = { name: '', type: 'tree', id: tree };
  for (const part of path.split('/').filter(Boolean)) {
    if (entry.type !== 'tree') throw new ApiError('NOT_FOUND', `${path} is not a directory`);
    const next = (await objects.tree(entry.id)).find((e) => e.name === part);
    if (!next) throw new ApiError('NOT_FOUND', `${path} does not exist`);
    entry = next;
  }
  return entry;
}

function text(bytes: Uint8Array) {
  try {
    return {
      encoding: 'utf-8',
      content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch {
    return { encoding: 'base64', content: toBase64(bytes) };
  }
}

export async function listTree(ctx: RepoContext, args: Json) {
  const where = await target(ctx, args.commit ?? args.ref, args.at);
  const objects = await ctx.objects();
  const path = String(args.path ?? '');
  const entry = await walk(objects, where.tree, path);
  if (entry.type !== 'tree') throw new ApiError('NOT_FOUND', `${path} is not a directory`);
  return { commit: where.commit, path, entries: await objects.tree(entry.id) };
}

export async function readFile(ctx: RepoContext, args: Json) {
  const where = await target(ctx, args.commit ?? args.ref, args.at);
  const objects = await ctx.objects();
  const path = String(args.path ?? '');
  const entry = await walk(objects, where.tree, path);
  if (!['blob', 'exec'].includes(entry.type))
    throw new ApiError('NOT_FOUND', `${path} is not a file`);
  const bytes = await objects.blob(entry.id);
  return {
    commit: where.commit,
    path,
    id: entry.id,
    executable: entry.type === 'exec',
    size: bytes.length,
    ...text(bytes),
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
  const trees: Record<string, TreeEntry[]> = {};
  let changes: Json[] = [];
  for (let round = 0; ; round++) {
    if (round > 64) throw new ApiError('INVALID_INPUT', 'Paths are nested too deeply');
    const result = compute({ op: 'tree_diff', old: base?.tree ?? null, new: head.tree, trees });
    if (!result.need_trees) {
      changes = result.changes;
      break;
    }
    await Promise.all(
      (result.need_trees as string[]).map(async (id) => {
        trees[id] = await objects.tree(id);
      }),
    );
  }
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
