// The agent layer's only route into the source platform: its public /api/v1, reached through
// the PLATFORM service binding (agent-only Worker) or this Worker itself (combined deployment).
// Projects act with their own repository token (read/write/check, never review or land),
// sealed in the owner's workspace. An owner action may forward the owner's own request
// credential for that one call; it is never stored.
import { safeId } from './http';
import { ledger } from './storage';
import type { Env, Json } from './types';
import { open, seal } from './vault';
import { workspace } from './workspace';

export type PlatformAuth = { token: string } | { forward: Request };
/**
 * Revisions of a project name `platform/<project id>`: the project's own platform repository,
 * resolved through its binding, so a revision can never address another project's source.
 */
export const PLATFORM_NAMESPACE = 'platform';
export const AGENT_SCOPES = ['read', 'write', 'check'];
/** The name of the project's agent token on its platform repository. */
export const AGENT_TOKEN = 'yoneda-agents';
/** The project's repository policy: agent checks must pass and the owner must approve. */
export const PLATFORM_POLICY = { required_checks: ['yoneda-checks'], approvals: 1 };

const failure = (code: string, message: string, status?: number) =>
  Object.assign(new Error(message), { code, status });

/** The agent project named by a revision's `repository`, or a refusal. */
export function revisionProject(repository: unknown): string {
  const [namespace, project, extra] = String(repository ?? '').split('/');
  if (namespace !== PLATFORM_NAMESPACE || extra !== undefined || !safeId(project ?? ''))
    throw failure('SOURCE_SCOPE', 'Source is not a platform repository revision');
  return project;
}
export const platformRevision = (project: string) => `${PLATFORM_NAMESPACE}/${project}`;

export async function platformRequest(
  env: Env,
  auth: PlatformAuth,
  method: string,
  path: string,
  body?: unknown,
): Promise<Json> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if ('token' in auth) headers.set('authorization', `Bearer ${auth.token}`);
  else
    for (const name of ['cookie', 'authorization']) {
      const value = auth.forward.headers.get(name);
      if (value) headers.set(name, value);
    }
  const target = env.PLATFORM ?? env.SELF;
  const response = await target.fetch(
    new Request(`https://platform/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const value: Json = await response.json<Json>().catch(() => ({}));
  if (!response.ok || value?.error)
    throw Object.assign(
      failure(
        value?.error?.code ?? 'PLATFORM_UNAVAILABLE',
        value?.error?.message ?? `Platform request failed (${response.status})`,
        response.status,
      ),
      // A landing's merge conflicts name their paths here.
      { details: value?.error?.details },
    );
  return value;
}

export type ProjectPlatform = {
  repo: string;
  call(method: string, path: string, body?: unknown): Promise<Json>;
};

const TOKEN_TTL_MS = 60_000;
type Credential = { repo: string; token: string; until: number; fresh: boolean };
const tokens = new Map<string, Credential>();
/** Repository owners never change; a stale entry (an identity reused after reset) is re-read. */
const owners = new Map<string, string>();

/** Seal and bind a freshly issued agent token; the first binding of a project wins. */
export async function bindPlatform(
  env: Env,
  owner: string,
  project: string,
  repo: string,
  token: string,
): Promise<string> {
  const bound = await workspace(env, owner, {
    op: 'project_platform_bind',
    id: project,
    platform_repo: repo,
    sealed: await seal(env, owner, 'platform', token, project),
  });
  return bound.platform.repo;
}

async function credential(env: Env, owner: string, project: string, reread: boolean) {
  const key = `${owner}\0${project}`;
  const cached = tokens.get(key);
  if (!reread && cached && cached.until >= Date.now()) return { ...cached, fresh: false };
  const sealed = await workspace(env, owner, { op: 'project_platform_credential', id: project });
  const token = await open(env, owner, 'platform', sealed.sealed, project);
  const next = { repo: sealed.repo, token, until: Date.now() + TOKEN_TTL_MS, fresh: true };
  tokens.set(key, next);
  return next;
}

/**
 * The project's platform repository and agent token, for the sandbox egress handler, which
 * adds it to the sandbox's own Git traffic so the token never enters the sandbox.
 */
export async function projectToken(env: Env, owner: string, project: string) {
  const { repo, token } = await credential(env, owner, project, false);
  return { repo, token };
}

/**
 * The project's platform repository, acting with the project's agent token. A cached token
 * the platform refuses (revoked, or a reused identity) is re-read once before failing.
 */
export async function projectPlatform(
  env: Env,
  owner: string,
  project: string,
): Promise<ProjectPlatform> {
  let current: Credential = await credential(env, owner, project, false);
  const send = (method: string, path: string, body?: unknown) =>
    platformRequest(env, { token: current.token }, method, `/repos/${current.repo}${path}`, body);
  return {
    get repo() {
      return current.repo;
    },
    async call(method, path, body) {
      try {
        return await send(method, path, body);
      } catch (failure: any) {
        if (current.fresh || ![401, 403, 404].includes(failure.status)) throw failure;
        current = await credential(env, owner, project, true);
        return send(method, path, body);
      }
    },
  };
}

/** The platform of an initialized agent repository (its ledger names the owner). */
export async function repositoryPlatform(env: Env, project: string): Promise<ProjectPlatform> {
  const lookup = async () => {
    const owner: string = (await ledger(env, project, { op: 'repository_status' })).workspace;
    owners.set(project, owner);
    return owner;
  };
  const cached = owners.get(project);
  if (cached === undefined) return projectPlatform(env, await lookup(), project);
  try {
    return await projectPlatform(env, cached, project);
  } catch (failure: any) {
    if (failure.code !== 'NOT_FOUND') throw failure;
    return projectPlatform(env, await lookup(), project);
  }
}
