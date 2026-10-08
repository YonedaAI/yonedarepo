import { source } from './artifacts';
import { error, readJson, response, safeId } from './http';
import { sitePolicy } from './site-policy';
import { ledger, sha } from './storage';
import type { Env, Json, Principal } from './types';
import { workspace } from './workspace';

export { sitePolicy } from './site-policy';
export function importSource(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error('Public HTTPS Git URL required');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org'].includes(url.hostname) ||
    url.pathname.split('/').filter(Boolean).length < 2
  )
    throw new Error('Import a public HTTPS repository from GitHub, GitLab, Codeberg or Bitbucket');
  return url.href;
}
export async function provisionProject(env: Env, owner: string, project: Json) {
  const id = project.id;
  try {
    try {
      const created = project.source
        ? await env.ARTIFACTS.import({
            source: { url: project.source },
            target: { name: id, opts: { description: 'YonedaRepo project' } },
          })
        : await (async () => {
            using starter = await env.ARTIFACTS.get(env.STARTER_REPO ?? 'yoneda-website-starter');
            return starter.fork(id, { defaultBranchOnly: true });
          })();
      using remote = await env.ARTIFACTS.get(id);
      await remote.revokeToken(created.token);
    } catch (e: any) {
      // Remote development proxies can lose structured error properties. Recover only
      // when a read proves this deterministic target exists; otherwise retain the failure.
      if (!['IMPORT_IN_PROGRESS', 'FORK_IN_PROGRESS', 'CREATE_IN_PROGRESS'].includes(e.code)) {
        try {
          using existing = await env.ARTIFACTS.get(id);
          await existing.info();
        } catch {
          throw e;
        }
      }
    }
    using remote = await env.ARTIFACTS.get(id);
    // Creation/import acknowledgment can be lost before its initial token is revoked.
    // While provisioning, clients have no Git grants; revoke any surviving initial capability.
    for (const token of (await remote.listTokens()).tokens)
      if (token.state === 'active') await remote.revokeToken(token.id);
    const info = await remote.info();
    const head = (await remote.log({ ref: info.defaultBranch, limit: 1 }))[0]?.hash;
    if (!head)
      throw Object.assign(new Error('Source is still being provisioned'), {
        code: 'IMPORT_IN_PROGRESS',
      });
    // Fail explicitly on unsupported paths/layouts before scheduling paid agents.
    await source(env, { repository: `${env.ARTIFACTS_NAMESPACE}/${id}`, commit: head });
    try {
      await ledger(env, id, {
        op: 'init',
        id,
        name: project.name,
        workspace: owner,
        commit: head,
        remote: { namespace: env.ARTIFACTS_NAMESPACE, name: id, branch: info.defaultBranch },
        policy: project.policy,
      });
    } catch (e: any) {
      if (e.code !== 'ALREADY_EXISTS') throw e;
      const existing = await ledger(env, id, { op: 'snapshot', _workspace: owner });
      if (existing.repository.remote.name !== id) throw new Error('Repository identity mismatch');
    }
    return workspace(env, owner, { op: 'project_update', id, status: 'ready' });
  } catch (e: any) {
    const pending = ['IMPORT_IN_PROGRESS', 'FORK_IN_PROGRESS', 'CREATE_IN_PROGRESS'].includes(
      e.code,
    );
    return workspace(env, owner, {
      op: 'project_update',
      id,
      status: pending ? 'provisioning' : 'failed',
      error: pending ? null : String(e.message ?? 'Provisioning failed').slice(0, 1000),
    });
  }
}
export async function projectRoute(
  req: Request,
  env: Env,
  principal: Principal,
): Promise<Response | null> {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  if (parts[1] !== 'projects') return null;
  if (principal.role !== 'user')
    return error('FORBIDDEN', 'Use a personal account to create projects', 403);
  if (parts.length === 2 && req.method === 'POST') {
    const body = await readJson(req);
    if (typeof body.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(body.request_id))
      return error('INVALID_INPUT', 'A stable request ID is required');
    const id = `repo-${(await sha(`${principal.workspace}:${body.request_id}`)).slice(0, 32)}`;
    const project = await workspace(env, principal.workspace, {
      op: 'project_reserve',
      id,
      name: body.name,
      source: importSource(body.source),
      policy: body.policy ?? sitePolicy,
    });
    const result =
      project.status === 'ready'
        ? project
        : await provisionProject(env, principal.workspace, project);
    return response(result, result.status === 'ready' ? 200 : 202);
  }
  if (
    safeId(parts[2]) &&
    ((parts.length === 3 && req.method === 'GET') ||
      (parts[3] === 'retry' && req.method === 'POST'))
  ) {
    const project = await workspace(env, principal.workspace, { op: 'project_get', id: parts[2] });
    return response(
      project.status === 'provisioning' || parts[3] === 'retry'
        ? await provisionProject(env, principal.workspace, project)
        : project,
    );
  }
  return error('NOT_FOUND', 'Unknown project route', 404);
}
