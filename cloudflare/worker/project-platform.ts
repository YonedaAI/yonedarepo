// A project's source is a platform repository, created during the requester's own request:
// the owner's session, or the operator provisioning a reviewer's project on their behalf.
// The repository is seeded from a published template (or a public Git import) and issues
// the project's agent token, which is sealed in the owner's workspace and never returned.
import {
  AGENT_SCOPES,
  AGENT_TOKEN,
  bindPlatform,
  PLATFORM_POLICY,
  platformRequest,
  projectPlatform,
} from './agents-platform';
import { sourceBranch } from './project-remote';
import type { Env, Json } from './types';

const TEMPLATE_FILES = 2000;
const TEMPLATE_BYTES = 16 * 1024 * 1024;
const AUTHOR = { name: 'YonedaRepo', email: 'projects@yonedarepo.invalid' };
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

export type ProjectSeed = { template: string; commit?: string } | { url: string };

/** Where a reserved project's first commit comes from. */
export async function projectSeed(env: Env, project: Json): Promise<ProjectSeed> {
  if (project.source) return { url: project.source };
  return { template: env.STARTER_REPO ?? 'yoneda-website-starter' };
}

function encode(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** Every regular file of a published template commit (templates are operator-owned). */
export async function templateFiles(env: Env, name: string, pinned?: string) {
  using repo = await env.ARTIFACTS.get(name);
  const commitId =
    pinned ?? (await repo.log({ ref: (await repo.info()).defaultBranch, limit: 1 }))[0]?.hash;
  const commit = commitId ? await repo.readCommit(commitId) : null;
  if (!commit) throw fail('NOT_FOUND', 'The project template could not be found');
  const files: Json[] = [];
  let bytes = 0;
  const walk = async (tree: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32) throw fail('SOURCE_LIMIT', 'Template nesting exceeds limit');
    const entries = await repo.readTree(tree);
    if (!entries) throw fail('NOT_FOUND', 'Template tree missing');
    for (const entry of entries) {
      const path = `${prefix}${entry.name}`;
      if (entry.type === 'tree') {
        await walk(entry.hash, `${path}/`, depth + 1);
        continue;
      }
      if (entry.type !== 'blob' && entry.type !== 'exec')
        throw fail('SOURCE_LIMIT', 'Templates contain only regular files');
      const blob = await repo.readBlob(entry.hash);
      if (!blob) throw fail('NOT_FOUND', 'Template blob missing');
      bytes += blob.size;
      if (files.length >= TEMPLATE_FILES || bytes > TEMPLATE_BYTES)
        throw fail('SOURCE_LIMIT', 'Template exceeds the project seed limit');
      files.push({
        path,
        type: entry.type,
        content_b64: encode(new Uint8Array(await blob.arrayBuffer())),
      });
    }
  };
  await walk(commit.treeHash, '', 0);
  return { commit: commit.hash, tree: commit.treeHash, files };
}

/** The platform's repository-name rule (yoneda-platform `rows::init`). */
const REPO_NAME_MAX = 100;

/** A project's display name as a repository name: runs of anything outside [A-Za-z0-9._-]
 * become one `-` (accents dropped first), no leading `.` or `-`, at most `max` characters;
 * empty when nothing usable is left. */
export function repoSlug(name: unknown, max = REPO_NAME_MAX) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, max)
    .replace(/[.-]+$/, '');
}

/**
 * The repository name for a project: its display name, made valid. The platform does not
 * require unique names per account, but the account MCP addresses repositories by name, so a
 * name the owner's repositories already use gets the first free `-2`, `-3`… suffix. A
 * concurrent creation may still pick the same name; that is allowed, only less convenient.
 */
export async function projectRepoName(env: Env, owner: string, project: Json) {
  const base = repoSlug(project.name, REPO_NAME_MAX - 4) || project.id;
  const { results } = await env.INDEX.prepare(
    'SELECT name FROM platform_repos WHERE workspace=? AND (name=? OR name LIKE ?)',
  )
    .bind(owner, base, `${base}-%`)
    .all<{ name: string }>();
  const taken = new Set(results.map((r) => r.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

/**
 * Bind the project to a platform repository, creating it with `requester`'s own credential.
 * `onBehalf` is the operator provisioning for `owner`. Replays reuse the first binding
 * without reading the seed again (default: the project's own `projectSeed`).
 */
export async function ensureProjectPlatform(
  env: Env,
  requester: Request,
  owner: string,
  project: Json,
  pinned?: ProjectSeed,
  onBehalf = false,
): Promise<string> {
  if (project.platform?.repo) return project.platform.repo;
  const seed = pinned ?? (await projectSeed(env, project));
  const common = {
    name: await projectRepoName(env, owner, project),
    policy: PLATFORM_POLICY,
    tokens: [{ name: AGENT_TOKEN, scopes: AGENT_SCOPES }],
    ...(onBehalf ? { workspace: owner } : {}),
  };
  const auth = { forward: requester };
  let created: Json;
  if ('url' in seed) {
    created = await platformRequest(env, auth, 'POST', '/repos/import', {
      ...common,
      url: seed.url,
      branch: await sourceBranch(seed.url),
    });
  } else {
    const template = await templateFiles(env, seed.template, seed.commit);
    created = await platformRequest(env, auth, 'POST', '/repos', {
      ...common,
      files: template.files,
      message: `Start from ${seed.template}`,
      author: AUTHOR,
    });
    // The seed reproduces the template tree exactly; anything else is not this template.
    if (created.tree !== template.tree)
      throw fail('IDEMPOTENCY_CONFLICT', 'The platform seed differs from its template');
  }
  const token = created.tokens?.[0]?.token;
  if (typeof token !== 'string') throw fail('PLATFORM_UNAVAILABLE', 'No agent token was issued');
  return bindPlatform(env, owner, project.id, created.id, token);
}

/** The main head of a bound project's repository, or a pending/failed setup reason. */
export async function platformHead(env: Env, owner: string, project: Json) {
  let platform: Awaited<ReturnType<typeof projectPlatform>>;
  try {
    platform = await projectPlatform(env, owner, project.id);
  } catch (failure: any) {
    if (failure.code !== 'NOT_FOUND') throw failure;
    throw fail('PLATFORM_UNBOUND', 'Repository setup needs your session; retry setup');
  }
  const { refs } = await platform.call('GET', '/refs');
  const head = refs['refs/heads/main'];
  if (head) return { platform, head: head as string };
  if (project.source) {
    const imported = await platform.call('GET', '/import');
    if (imported.status === 'errored' || imported.status === 'terminated')
      throw fail('NOT_FOUND', 'The repository could not be imported');
    throw fail('IMPORT_IN_PROGRESS', 'The repository import is still running');
  }
  throw fail('EMPTY_REPOSITORY', 'The repository has no commit on main');
}
