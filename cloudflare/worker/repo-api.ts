// Public API of the YonedaRepo source platform (`/api/v1`). A thin adapter: it
// authenticates, performs object-store I/O, and forwards commands to the repository's
// SourceRepository Durable Object, which owns every decision. Callers are workspace
// sessions (owners) or repository tokens (agents, CI, scripts) — all the same to us.
import { authenticate } from './auth';
import { error, readJson, response } from './http';
import {
  type CachedObject,
  fromBase64,
  RepoObjects,
  type TreeEntry,
  toBase64,
} from './repo-objects';
import type { Env } from './types';

type Json = Record<string, any>;
type Credentials = { _session: { workspace: string; principal: string } } | { _token: string };
class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  MERGE_REQUIRED: 409,
  STALE_PARENT: 409,
  NOT_READY: 409,
  ALREADY_EXISTS: 409,
  PUSH_FAILED: 502,
};
const COMMIT_BODY_LIMIT = 64 * 1024 * 1024;
const bodyOf = (req: Request, limit?: number) =>
  readJson(req, limit).catch((e) => {
    throw new ApiError('INVALID_INPUT', String(e?.message ?? e));
  });

async function credentials(req: Request, env: Env): Promise<Credentials | null> {
  const bearer = req.headers.get('authorization');
  if (bearer?.startsWith('Bearer yrp_')) return { _token: bearer.slice(7) };
  const principal = await authenticate(req, env);
  if (!principal || principal.role === 'agent') return null;
  const name = principal.role === 'admin' ? 'admin' : `user:${principal.workspace}`;
  return { _session: { workspace: principal.workspace, principal: name } };
}

function caller(env: Env, repo: string, auth: Credentials) {
  const stub = env.SOURCE_REPOS.get(env.SOURCE_REPOS.idFromName(repo));
  return async (command: Json): Promise<Json> => {
    const result = await stub.fetch('https://source-repository/', {
      method: 'POST',
      body: JSON.stringify({ ...command, ...auth }),
    });
    const value = await result.json<Json>();
    if (value.error) throw new ApiError(value.error.code, value.error.message);
    return value;
  };
}
type Call = ReturnType<typeof caller>;

async function objectsFor(env: Env, repo: string, call: Call) {
  const status = await call({ op: 'repo_status' });
  return new RepoObjects(env, repo, RepoObjects.parseStore(env, status.object_store));
}

/** Prepare (answering tree requests), push, read back from the store, record. */
async function commit(call: Call, objects: RepoObjects, body: Json) {
  let { parent, base_version } = body;
  if (!parent && body.ref) {
    const snapshot = await call({ op: 'repo_snapshot', ref: body.ref });
    parent = snapshot.commit;
    base_version = snapshot.version;
  }
  const trees: Record<string, TreeEntry[]> = {};
  for (let round = 0; round < 64; round++) {
    const prepared = await call({
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
    await call({
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
    };
  }
  throw new ApiError('INVALID_INPUT', 'Paths are nested too deeply');
}

async function resolve(call: Call, url: URL) {
  const sha = url.searchParams.get('commit');
  if (sha) return call({ op: 'repo_commit', commit: sha });
  const at = url.searchParams.get('at');
  return call({
    op: 'repo_snapshot',
    ref: url.searchParams.get('ref') ?? 'main',
    ...(at ? { at: Number(at) } : {}),
  });
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

async function createRepository(env: Env, auth: Credentials, body: Json) {
  if (!('_session' in auth))
    throw new ApiError('FORBIDDEN', 'Repositories are created by workspace owners');
  const random = crypto.getRandomValues(new Uint8Array(10));
  const id = `r${[...random].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const store = `yr-${id}`;
  await env.ARTIFACTS.create(store, { setDefaultBranch: 'main' });
  const call = caller(env, id, auth);
  await call({
    op: 'repo_init',
    object_store: `artifacts:${env.ARTIFACTS_NAMESPACE}/${store}`,
    policy: body.policy ?? { required_checks: [], approvals: 1 },
  });
  if (!Array.isArray(body.files) || body.files.length === 0) return { id };
  const seeded = await commit(call, new RepoObjects(env, id, store), {
    changes: body.files,
    message: body.message ?? 'Import',
    author: body.author,
  });
  const landed = await call({ op: 'repo_import', ref: 'main', commit: seeded.commit });
  return { id, commit: seeded.commit, version: landed.version };
}

async function route(req: Request, env: Env, url: URL, auth: Credentials): Promise<Json> {
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after api/v1
  if (parts[0] !== 'repos') throw new ApiError('NOT_FOUND', 'Unknown API path');
  if (parts.length === 1 && req.method === 'POST')
    return createRepository(env, auth, await bodyOf(req, COMMIT_BODY_LIMIT));
  const repo = parts[1];
  if (!/^r[0-9a-f]{20}$/.test(repo ?? '')) throw new ApiError('NOT_FOUND', 'Unknown repository');
  const call = caller(env, repo, auth);
  const [resource, sha, sub] = parts.slice(2);
  const get = req.method === 'GET';
  const query = (key: string) => url.searchParams.get(key);
  const at = query('at') ? { at: Number(query('at')) } : {};
  if (!resource && get) return call({ op: 'repo_status' });
  if (resource === 'refs' && get) return call({ op: 'repo_refs', ...at });
  if (resource === 'log' && get)
    return call({
      op: 'repo_log',
      ref: query('ref') ?? 'main',
      limit: Number(query('limit') ?? 50),
      ...at,
    });
  if (resource === 'txlog' && get)
    return call({
      op: 'repo_txlog',
      after: Number(query('after') ?? 0),
      limit: Number(query('limit') ?? 100),
    });
  if (resource === 'commits' && sha && !sub && get) return call({ op: 'repo_commit', commit: sha });
  if (resource === 'commits' && !sha && req.method === 'POST')
    return commit(call, await objectsFor(env, repo, call), await bodyOf(req, COMMIT_BODY_LIMIT));
  if (resource === 'commits' && sha && sub === 'checks' && req.method === 'POST') {
    const body = await bodyOf(req);
    return call({
      op: 'repo_check',
      commit: sha,
      name: body.name,
      status: body.status,
      evidence: body.evidence,
    });
  }
  if (resource === 'commits' && sha && sub === 'reviews' && req.method === 'POST') {
    const body = await bodyOf(req);
    return call({ op: 'repo_review', commit: sha, decision: body.decision, reason: body.reason });
  }
  if (resource === 'land' && req.method === 'POST') {
    const body = await bodyOf(req);
    return call({ op: 'repo_land', ref: body.ref, commit: body.commit });
  }
  if ((resource === 'tree' || resource === 'blob') && get) {
    const target = await resolve(call, url);
    const objects = await objectsFor(env, repo, call);
    const path = query('path') ?? '';
    const entry = await walk(objects, target.tree, path);
    if (resource === 'tree') {
      if (entry.type !== 'tree') throw new ApiError('NOT_FOUND', `${path} is not a directory`);
      return { commit: target.commit, path, entries: await objects.tree(entry.id) };
    }
    if (!['blob', 'exec'].includes(entry.type))
      throw new ApiError('NOT_FOUND', `${path} is not a file`);
    const bytes = await objects.blob(entry.id);
    return {
      commit: target.commit,
      path,
      id: entry.id,
      executable: entry.type === 'exec',
      size: bytes.length,
      ...text(bytes),
    };
  }
  if (resource === 'tokens' && get) return call({ op: 'repo_tokens' });
  if (resource === 'tokens' && !sha && req.method === 'POST') {
    const body = await bodyOf(req);
    const secret = `yrp_${toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] ?? '')}`;
    const created = await call({
      op: 'repo_token_create',
      name: body.name,
      scopes: body.scopes,
      _secret: secret,
    });
    return { ...created, token: secret };
  }
  if (resource === 'tokens' && sha && req.method === 'DELETE')
    return call({ op: 'repo_token_revoke', name: sha });
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}

export async function repoApi(req: Request, env: Env): Promise<Response> {
  const auth = await credentials(req, env);
  if (!auth) return error('UNAUTHORIZED', 'Sign in or use a repository token', 401);
  try {
    return response(await route(req, env, new URL(req.url), auth));
  } catch (e: any) {
    const code = e instanceof ApiError ? e.code : (e?.code ?? 'INVALID_INPUT');
    const message = String(e?.message ?? e).slice(0, 500);
    return error(code, message, STATUS[code] ?? (e instanceof ApiError || e?.code ? 400 : 500));
  }
}
