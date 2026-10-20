import { isCanonicalAccountIdentifier } from '../../shared/account';
import { PLATFORM_NAMESPACE } from './agents-platform';
import { validateSourceMetadata } from './artifacts';
import { safeId } from './http';
import { writeLog } from './logging';
import { platformHead } from './project-platform';
import { pendingSetup, setupCode, setupError, setupMessage } from './project-remote';
import { sourceFingerprint } from './source-crypto';
import { platformSource } from './source-objects';
import { ledger } from './storage';
import type { Env, Envelope, Json } from './types';
import { workspace } from './workspace';

async function initializeProject(
  env: Env,
  owner: string,
  project: Json,
  progress: (stage: string) => Promise<Json>,
) {
  await progress(project.source ? 'importing' : 'creating');
  const current = await workspace(env, owner, { op: 'project_get', id: project.id });
  if (current.status === 'deleted')
    throw setupError('REPOSITORY_DELETED', 'This repository has been deleted');
  const { platform, head } = await platformHead(env, owner, current);
  await progress('checking_source');
  const checked = await validateSourceMetadata(platformSource(platform), head);
  await progress('initializing');
  try {
    await ledger(env, project.id, {
      op: 'init',
      id: project.id,
      name: project.name,
      workspace: owner,
      commit: head,
      tree: checked.tree,
      platform_repo: platform.repo,
      remote: { namespace: PLATFORM_NAMESPACE, name: project.id, branch: 'main' },
      policy: project.policy,
      ...(project.guided_project ? { _guided_project: project.guided_project } : {}),
    });
  } catch (error: any) {
    if (error.code !== 'ALREADY_EXISTS') throw error;
    const existing = await ledger(env, project.id, { op: 'snapshot', _workspace: owner });
    if (existing.repository.remote.name !== project.id)
      throw new Error('Repository identity mismatch');
    if (
      project.guided_project &&
      (!existing.repository.guided_project ||
        (await sourceFingerprint(existing.repository.guided_project)) !==
          (await sourceFingerprint(project.guided_project)))
    )
      throw setupError('IDEMPOTENCY_CONFLICT', 'Existing repository has another guided profile');
  }
  if (project.guided_project) {
    const stored = await ledger(env, project.id, { op: 'repository_status', _workspace: owner });
    if (stored.capabilities?.guided_runs !== 1 || !stored.guided_project)
      throw setupError('LEDGER_UPDATING', 'Guided repository setup is updating; retry shortly.');
    if (
      (await sourceFingerprint(stored.guided_project)) !==
        (await sourceFingerprint(project.guided_project)) ||
      (await sourceFingerprint(stored.policy)) !== project.guided_project.policy_digest
    )
      throw setupError(
        'IDEMPOTENCY_CONFLICT',
        'The initialized guided profile differs from its fixed reservation',
      );
  }
}

export async function provisionProject(env: Env, owner: string, project: Json) {
  const claimed = await workspace(env, owner, { op: 'project_claim', id: project.id });
  if (!claimed.claimed) return claimed;
  const start = Date.now();
  let active = true;
  const progress = async (stage: string) => {
    if (!active) throw setupError('FENCED', 'Repository setup timed out');
    const result = await workspace(env, owner, {
      op: 'project_progress',
      id: project.id,
      epoch: claimed.setup_epoch,
      stage,
    });
    if (!active) throw setupError('FENCED', 'Repository setup timed out');
    writeLog('project.setup_progress', { repo_id: project.id, stage, epoch: claimed.setup_epoch });
    return result;
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      initializeProject(env, owner, claimed, progress),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          active = false;
          reject(
            setupError(
              'SETUP_TIMEOUT',
              'Repository setup did not respond within 90 seconds. Retry setup; existing source is preserved.',
            ),
          );
        }, 90_000);
      }),
    ]);
    const ready = await workspace(env, owner, {
      op: 'project_update',
      id: project.id,
      epoch: claimed.setup_epoch,
      status: 'ready',
    });
    writeLog('project.setup_ready', {
      repo_id: project.id,
      epoch: claimed.setup_epoch,
      duration_ms: Date.now() - start,
    });
    return ready;
  } catch (error: any) {
    const current = await workspace(env, owner, { op: 'project_get', id: project.id });
    if (current.status === 'deleted' || error.code === 'REPOSITORY_DELETED')
      throw setupError('REPOSITORY_DELETED', 'This repository has been deleted');
    if (current.status === 'ready' || error.code === 'FENCED')
      return { ...current, claimed: false };
    const pending = pendingSetup(error);
    const code = setupCode(error);
    const result = await workspace(env, owner, {
      op: 'project_update',
      id: project.id,
      epoch: claimed.setup_epoch,
      status: pending ? 'provisioning' : 'failed',
      pending_code: pending ? code : null,
      error_code: pending ? null : code,
      error: pending ? null : setupMessage(error),
    });
    writeLog(pending ? 'project.setup_waiting' : 'project.setup_failed', {
      repo_id: project.id,
      epoch: claimed.setup_epoch,
      error_code: pending ? undefined : code,
      duration_ms: Date.now() - start,
    });
    return result;
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

export async function scheduleProject(env: Env, owner: string, project: Json, delaySeconds = 0) {
  if (project.status !== 'provisioning') return;
  delaySeconds = Math.max(
    delaySeconds,
    Math.ceil(Math.max(0, (project.lease_until ?? 0) - Date.now()) / 1000),
  );
  await env.AGENT_QUEUE.send(
    { v: 1, kind: 'provision', repo_id: project.id, job_id: project.id, workspace: owner },
    { delaySeconds },
  );
}

/** Background HTTP and queue work share the native pending-retry receipt. */
export async function provisionAndScheduleProject(env: Env, owner: string, project: Json) {
  const result = await provisionProject(env, owner, project);
  if (
    result.status === 'provisioning' &&
    result.claimed !== false &&
    result.lease_until === 0 &&
    [2, 5, 15].includes(result.retry_delay_seconds)
  )
    await scheduleProject(env, owner, result, result.retry_delay_seconds);
  return result;
}

export async function provisionMessage(env: Env, message: Message<Envelope>) {
  const body = message.body;
  if (!body.workspace || !isCanonicalAccountIdentifier(body.workspace)) {
    message.ack();
    return;
  }
  try {
    const current = await workspace(env, body.workspace, { op: 'project_get', id: body.repo_id });
    if (current.status === 'deleted') {
      message.ack();
      return;
    }
    await provisionAndScheduleProject(env, body.workspace, current);
    // Workspace DO alarms retain dispatch intent through pending imports, expired leases
    // and missing acknowledgments, independently of the queue's delivery retry limit.
    message.ack();
  } catch (error: any) {
    if (['REPOSITORY_DELETED', 'NOT_FOUND'].includes(error.code)) message.ack();
    else message.retry({ delaySeconds: 20 });
    writeLog('project.dispatch_failed', { repo_id: body.repo_id, error_code: setupCode(error) });
  }
}

export async function enqueueProjects(env: Env, owner: string, projects: Json[]) {
  const delivered: string[] = [];
  if (!isCanonicalAccountIdentifier(owner)) return delivered;
  for (const project of projects) {
    if (!safeId(project.id)) continue;
    try {
      await scheduleProject(env, owner, { id: project.id, status: 'provisioning' });
      delivered.push(project.id);
    } catch {
      writeLog('project.dispatch_failed', { repo_id: project.id, error_code: 'SETUP_FAILED' });
    }
  }
  return delivered;
}
