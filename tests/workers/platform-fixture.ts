// Agent-layer fixtures over the real source platform: projects get an actual platform
// repository (R2 object store, real SourceRepository DO) reached through the public API,
// and only the operator-published template store (Artifacts) is synthetic.
import {
  AGENT_SCOPES,
  AGENT_TOKEN,
  bindPlatform,
  PLATFORM_POLICY,
  platformRequest,
  platformRevision,
  projectPlatform,
} from '../../cloudflare/worker/agents-platform';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

export type FixtureFiles = Record<string, string | Uint8Array>;
export const author = { name: 'Fixture Client', email: 'fixture@example.com' };
export const operator = () =>
  new Request('https://yoneda/', { headers: { authorization: 'Bearer local-test-owner' } });

const encoder = new TextEncoder();
const bytesOf = (value: string | Uint8Array) =>
  typeof value === 'string' ? encoder.encode(value) : value;
const toHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
export const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Real Git object ids for an in-memory snapshot, as the platform computes them. */
export async function gitSnapshot(files: FixtureFiles) {
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, { name: string; mode: string; hash: string; type: string }[]>();
  const oid = async (kind: string, body: Uint8Array) =>
    toHex(await crypto.subtle.digest('SHA-1', concat(encoder.encode(`${kind} ${body.length}\0`), body)));
  async function tree(prefix: string): Promise<string> {
    const names = new Map<string, 'blob' | 'tree'>();
    for (const path of Object.keys(files))
      if (path.startsWith(prefix)) {
        const [name, ...rest] = path.slice(prefix.length).split('/');
        names.set(name, rest.length ? 'tree' : 'blob');
      }
    const entries = [];
    for (const [name, type] of names) {
      if (type === 'tree') entries.push({ name, mode: '40000', type, hash: await tree(`${prefix}${name}/`) });
      else {
        const body = bytesOf(files[`${prefix}${name}`]);
        const hash = await oid('blob', body);
        blobs.set(hash, body);
        entries.push({ name, mode: '100644', type, hash });
      }
    }
    // Git orders a tree's children by name, comparing subtrees as if they ended in '/'.
    const key = (e: { name: string; type: string }) => (e.type === 'tree' ? `${e.name}/` : e.name);
    entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const body = concat(
      ...entries.map((e) => concat(encoder.encode(`${e.mode} ${e.name}\0`), Uint8Array.from(e.hash.match(/../g)!, (h) => Number.parseInt(h, 16)))),
    );
    const hash = await oid('tree', body);
    trees.set(hash, entries);
    return hash;
  }
  const root = await tree('');
  const commit = await oid('commit', encoder.encode(`tree ${root}\n\nFixture template\n`));
  return { root, commit, blobs, trees };
}

export const websiteStarter: FixtureFiles = {
  'README.md': '# Website starter\n',
  'public/index.html': '<!doctype html><title>Starter</title>\n',
};

/** Operator-published template repositories, served like the Artifacts SDK does. */
export async function templateArtifacts(templates: Record<string, FixtureFiles> = {}, fallback = websiteStarter) {
  const snapshots = new Map<string, Awaited<ReturnType<typeof gitSnapshot>>>();
  const snapshot = async (name: string) => {
    if (!snapshots.has(name)) snapshots.set(name, await gitSnapshot(templates[name] ?? fallback));
    return snapshots.get(name)!;
  };
  return {
    snapshot,
    get: async (name: string) => {
      const s = await snapshot(name);
      return {
        [Symbol.dispose]() {},
        info: async () => ({ name, defaultBranch: 'main' }),
        log: async () => [{ hash: s.commit }],
        readCommit: async (hash: string) => (hash === s.commit ? { hash, treeHash: s.root, parents: [] } : null),
        readTree: async (hash: string) => s.trees.get(hash)?.map((e) => ({ ...e })) ?? null,
        readBlob: async (hash: string) => (s.blobs.has(hash) ? new Blob([s.blobs.get(hash)!]) : null),
      };
    },
  };
}

/** Reserve the workspace project (when absent) and bind it to a platform repository token. */
export async function bindProject(env: Env, owner: string, project: string, repo: string, token: string) {
  try {
    await workspace(env, owner, { op: 'project_get', id: project });
  } catch {
    // Owners without a signed-up account get one, as the deployed signup would create it.
    await workspace(env, owner, { op: 'signup', username: owner, password: 'long fixture password',
      salt: '0'.repeat(32), session_hash: '0'.repeat(64), recovery_hash: '1'.repeat(64) }).catch(() => {});
    await workspace(env, owner, { op: 'project_reserve', id: project, name: project, policy: reviewerPolicy });
    await workspace(env, owner, { op: 'project_update', id: project, status: 'ready' });
  }
  return bindPlatform(env, owner, project, repo, token);
}

/**
 * An initialized agent project over a fresh platform repository seeded with `files`,
 * created by the operator for `owner` and bound to its own agent token.
 */
export async function platformProject(
  env: Env,
  owner: string,
  project: string,
  files: FixtureFiles = websiteStarter,
  policy: Json = reviewerPolicy,
) {
  const created = await bindNewPlatformRepo(env, owner, project, files);
  await ledger(env, project, {
    op: 'init',
    id: project,
    name: project,
    workspace: owner,
    remote: { namespace: 'platform', name: project, branch: 'main' },
    commit: created.commit,
    tree: created.tree,
    platform_repo: created.repo,
    policy,
  });
  const base = { repository: platformRevision(project), commit: created.commit as string, tree: created.tree as string };
  return { repo: created.repo, base, platform: await projectPlatform(env, owner, project) };
}

/** Commit `files` (path → content, null deletes) onto `parent` with the agent token. */
export async function platformCommit(
  platform: Awaited<ReturnType<typeof projectPlatform>>,
  parent: string,
  files: Record<string, string | Uint8Array | null>,
  message = 'Fixture change',
) {
  const changes = Object.entries(files).map(([path, content]) =>
    content === null ? { path, delete: true } : { path, content_b64: base64(bytesOf(content)) },
  );
  const made = await platform.call('POST', '/commits', { parent, changes, message, author });
  return { commit: made.commit as string, tree: made.tree as string };
}

type SyntheticRepo = {
  readCommit(hash: string): Promise<{ hash: string; treeHash: string; parents?: string[] } | null>;
  readTree?(hash: string): Promise<{ name: string; hash: string; type: string }[] | null>;
  readBlob?(hash: string): Promise<Blob | null>;
};

/**
 * Synthetic platform repositories for source-service tests that exercise the SourceWS, index
 * and cache rather than the platform: each named project is initialized and bound like a real
 * one, and its object reads are answered by `repos[project]` at the PLATFORM binding. Other
 * platform calls reach the real platform.
 */
export async function syntheticPlatform(env: Env, repos: Record<string, SyntheticRepo>, owner = 'source_owner') {
  const ids = new Map<string, SyntheticRepo>();
  for (const [index, [project, repo]] of Object.entries(repos).entries()) {
    const id = `r${String(index + 1).padStart(20, '0')}`;
    ids.set(id, repo);
    await bindProject(env, owner, project, id, `yrp_synthetic_${index}`);
    // A project the test already initialized keeps its own ledger (and must name `owner`).
    const initialized = await ledger(env, project, { op: 'repository_status' }).then(() => true, () => false);
    if (!initialized)
      await ledger(env, project, { op: 'init', id: project, name: project, workspace: owner,
        remote: { namespace: 'platform', name: project, branch: 'main' }, commit: 'a'.repeat(40),
        tree: 'b'.repeat(40), platform_repo: id, policy: reviewerPolicy });
  }
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  async function answer(repo: SyntheticRepo, request: Request, path: string[]) {
    if (path[0] === 'objects' && request.method === 'POST') {
      const body = await request.json<{ objects: { id: string; kind: string }[]; after?: number }>();
      const objects = [];
      for (const { id, kind } of body.objects.slice(body.after ?? 0)) {
        if (kind === 'commit') {
          const commit = await repo.readCommit(id);
          if (commit) objects.push({ id, kind, tree: commit.treeHash, parents: commit.parents ?? [] });
        } else if (kind === 'tree') {
          const entries = await repo.readTree?.(id);
          if (entries) objects.push({ id, kind, entries: entries.map((e) => ({ name: e.name, type: e.type, id: e.hash })) });
        } else {
          const blob = await repo.readBlob?.(id);
          if (blob) objects.push({ id, kind, data_b64: base64(new Uint8Array(await new Response(blob.stream()).arrayBuffer())) });
        }
      }
      return json({ objects, next: null });
    }
    if (path[0] === 'commits' && path.length === 2 && request.method === 'GET') {
      const commit = await repo.readCommit(path[1]);
      return commit
        ? json({ commit: path[1], tree: commit.treeHash, parents: commit.parents ?? [], message: 'Synthetic', principal: 'fixture' })
        : json({ error: { code: 'NOT_FOUND', message: 'Unknown commit' } }, 404);
    }
    if (path[0] === 'refs') return json({ refs: {} });
    return json({ error: { code: 'NOT_SUPPORTED', message: `Synthetic platform: ${path.join('/')}` } }, 400);
  }
  const PLATFORM = {
    async fetch(input: RequestInfo, init?: RequestInit) {
      const request = new Request(input, init);
      const [, , , repos, id, ...rest] = new URL(request.url).pathname.split('/');
      const repo = repos === 'repos' ? ids.get(id) : undefined;
      if (!repo) return env.SELF.fetch(request);
      try {
        return await answer(repo, request, rest);
      } catch (failure: any) {
        return json({ error: { code: failure.code ?? 'SYNTHETIC_FAILURE', message: String(failure.message) } }, 500);
      }
    },
  };
  return { ...env, PLATFORM } as unknown as Env;
}

/**
 * Bind an existing workspace project to a fresh real platform repository, seeded with
 * `files` or left empty (`null`), as the owner's setup request would have.
 */
export async function bindNewPlatformRepo(env: Env, owner: string, project: string, files: FixtureFiles | null = websiteStarter) {
  const created = await platformRequest(env, { forward: operator() }, 'POST', '/repos', {
    name: project,
    workspace: owner,
    policy: PLATFORM_POLICY,
    tokens: [{ name: AGENT_TOKEN, scopes: AGENT_SCOPES }],
    ...(files
      ? { files: Object.entries(files).map(([path, content]) => ({ path, content_b64: base64(bytesOf(content)) })), message: 'Fixture seed', author }
      : {}),
  });
  await bindProject(env, owner, project, created.id, created.tokens[0].token);
  return { repo: created.id as string, commit: created.commit as string | undefined, tree: created.tree as string | undefined };
}

/**
 * A PLATFORM binding that answers matching requests itself (`intercept` returns a Response)
 * and forwards everything else to the real platform. `path` is the part after `/api/v1`.
 */
export function interceptPlatform(
  env: Env,
  intercept: (path: string, request: Request) => Promise<Response | undefined> | Response | undefined,
) {
  const PLATFORM = {
    async fetch(input: RequestInfo, init?: RequestInit) {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname.replace(/^\/api\/v1/, '');
      return (await intercept(path, request.clone())) ?? env.SELF.fetch(request);
    },
  };
  return { ...env, PLATFORM } as unknown as Env;
}
export const platformJson = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
