import { isCanonicalAccountIdentifier } from '../../shared/account';
import { source } from './artifacts';
import { safeId } from './http';
import { writeLog } from './logging';
import {
  pendingSetup,
  prepareRemote,
  setupCode,
  setupError,
  setupMessage,
  sourceBranch,
} from './project-remote';
import { cleanupLateRemote } from './repository-deletion';
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
  await prepareRemote(env, project);
  const current = await workspace(env, owner, { op: 'project_get', id: project.id });
  if (current.status === 'deleted') {
    await cleanupLateRemote(env, project.id, project.id);
    throw setupError('REPOSITORY_DELETED', 'This repository has been deleted');
  }
  using remote = await env.ARTIFACTS.get(project.id);
  // Lost creation acknowledgments may leave the initial Git capability active.
  for (const token of (await remote.listTokens()).tokens)
    if (token.state === 'active') await remote.revokeToken(token.id);
  const info = await remote.info();
  let branch = info.defaultBranch;
  let head = (await remote.log({ ref: branch, limit: 1 }))[0]?.hash;
  // Recover earlier imports whose Artifacts metadata points at a nonexistent "main".
  if (!head && project.source) {
    branch = await sourceBranch(project.source);
    head = (await remote.log({ ref: branch, limit: 1 }))[0]?.hash;
  }
  if (!head)
    throw setupError(
      'EMPTY_REPOSITORY',
      'The repository has no commit on its default branch. Push an initial commit, then retry setup.',
    );
  await progress('checking_source');
  await source(env, { repository: `${env.ARTIFACTS_NAMESPACE}/${project.id}`, commit: head });
  await progress('initializing');
  try {
    await ledger(env, project.id, {
      op: 'init',
      id: project.id,
      name: project.name,
      workspace: owner,
      commit: head,
      remote: { namespace: env.ARTIFACTS_NAMESPACE, name: project.id, branch },
      policy: project.policy,
    });
  } catch (error: any) {
    if (error.code !== 'ALREADY_EXISTS') throw error;
    const existing = await ledger(env, project.id, { op: 'snapshot', _workspace: owner });
    if (existing.repository.remote.name !== project.id)
      throw new Error('Repository identity mismatch');
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
    if (current.status === 'deleted' || error.code === 'REPOSITORY_DELETED') {
      await cleanupLateRemote(env, project.id, project.id);
      throw setupError('REPOSITORY_DELETED', 'This repository has been deleted');
    }
    if (current.status === 'ready' || error.code === 'FENCED') return current;
    const pending = pendingSetup(error);
    const code = setupCode(error);
    const result = await workspace(env, owner, {
      op: 'project_update',
      id: project.id,
      epoch: claimed.setup_epoch,
      status: pending ? 'provisioning' : 'failed',
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
    await provisionProject(env, body.workspace, current);
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
