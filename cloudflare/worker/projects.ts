import { assertGuidedReservation, guidedProjectInput } from './guided-project';
import { error, readJson, response, safeId } from './http';
import { failureCode, writeLog } from './logging';
import { provisionAndScheduleProject, scheduleProject } from './project-provisioning';
import { changeProjectVisibility } from './project-visibility';
import { sitePolicy } from './site-policy';
import { sha } from './storage';
import type { Env, Principal } from './types';
import { workspace } from './workspace';

export { provisionProject } from './project-provisioning';
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
export async function projectRoute(
  req: Request,
  env: Env,
  principal: Principal,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | null> {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  if (parts[1] !== 'projects') return null;
  if (principal.role !== 'user')
    return error('FORBIDDEN', 'Use a personal account to create projects', 403);
  if (safeId(parts[2]) && parts.length === 4 && parts[3] === 'visibility' && req.method === 'POST')
    return changeProjectVisibility(req, env, principal, parts[2]);
  if (parts.length === 2 && req.method === 'POST') {
    const body = await readJson(req);
    if (typeof body.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(body.request_id))
      return error('INVALID_INPUT', 'A stable request ID is required');
    const id = `repo-${(await sha(`${principal.workspace}:${body.request_id}`)).slice(0, 32)}`;
    const configuration =
      body.guided_profile_id !== undefined
        ? await guidedProjectInput(env, principal.workspace, id, body)
        : { source: importSource(body.source), policy: body.policy ?? sitePolicy };
    const project = await workspace(env, principal.workspace, {
      op: 'project_reserve',
      id,
      name: body.name,
      ...configuration,
    });
    await assertGuidedReservation(project, configuration);
    await scheduleProject(env, principal.workspace, project);
    // Durable queue/alarm intent exists before the optional latency fast path.
    // Remote I/O stays in background; its existing lease/deadline is unchanged.
    if (ctx && project.status === 'provisioning')
      ctx.waitUntil(
        provisionAndScheduleProject(env, principal.workspace, project).catch((failure: unknown) => {
          writeLog('project.background_setup_failed', {
            repo_id: project.id,
            error_code: failureCode(failure),
          });
        }),
      );
    return response(project, project.status === 'ready' ? 200 : 202);
  }
  if (
    safeId(parts[2]) &&
    ((parts.length === 3 && req.method === 'GET') ||
      (parts[3] === 'retry' && req.method === 'POST'))
  ) {
    const project = await workspace(env, principal.workspace, { op: 'project_get', id: parts[2] });
    if (project.status === 'deleted')
      return error('REPOSITORY_DELETED', 'This repository has been deleted', 410);
    if (parts[3] === 'retry') {
      const retry = await workspace(env, principal.workspace, {
        op: 'project_retry',
        id: project.id,
      });
      await scheduleProject(env, principal.workspace, retry);
      return response(retry, retry.status === 'ready' ? 200 : 202);
    }
    if (project.status === 'provisioning' && !project.stage) {
      const recovery = await workspace(env, principal.workspace, {
        op: 'project_schedule',
        id: project.id,
      });
      if (recovery.schedule) await scheduleProject(env, principal.workspace, recovery);
      return response(recovery);
    }
    return response(project);
  }
  return error('NOT_FOUND', 'Unknown project route', 404);
}
