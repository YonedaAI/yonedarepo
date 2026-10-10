import { WorkerEntrypoint } from 'cloudflare:workers';
import { now } from './http';
import { attemptLog, failureCode, writeLog } from './logging';
import { deliverOutbox } from './outbox-delivery';
import { enqueueProjects, provisionMessage } from './project-provisioning';
import { cleanupLateRemote } from './repository-deletion';
import { fetchRequest } from './routes';
import { modelForJob } from './runtime';
import { authorizePreview } from './sites';
import { ledger, sha } from './storage';
import type { Env, Envelope, Json, Scope } from './types';
export class YonedaEntrypoint extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    return fetchRequest(req, this.env);
  }

  async authorizePreview(digest: string, token: string) {
    return authorizePreview(this.env, digest, token);
  }
  async siteManifest(repo: string): Promise<{ digest: string; commit: string } | null> {
    try {
      const repository = await ledger(this.env, repo, { op: 'repository_status' });
      return repository.site ?? null;
    } catch (error: any) {
      if (['REPOSITORY_DELETED', 'NOT_FOUND'].includes(error.code)) return null;
      throw error;
    }
  }
  // Internal service RPC; these methods are not exposed through public fetch routes.
  async deliver(repo: string, entries: Json[]) {
    return deliverOutbox(this.env, repo, entries);
  }
  async enqueueProjects(owner: string, projects: Json[]) {
    return enqueueProjects(this.env, owner, projects);
  }

  async queue(batch: MessageBatch<Envelope>) {
    await Promise.all(
      batch.messages.map(async (message) => {
        const envelope = message.body;
        try {
          if (envelope.v !== 1) {
            message.ack();
            return;
          }
          if (envelope.kind === 'provision') {
            await provisionMessage(this.env, message);
            return;
          }
          const job = await ledger(this.env, envelope.repo_id, {
            op: 'claim',
            job_id: envelope.job_id,
            models: { codex: this.env.CODEX_MODEL, claude: this.env.CLAUDE_MODEL },
          });
          if (job.deferred) {
            message.retry({
              delaySeconds: Math.max(1, Math.ceil((job.not_before - now()) / 1000)),
            });
            return;
          }
          if (job.already_done) {
            message.ack();
            return;
          }
          job.model = modelForJob(job, {
            codex: this.env.CODEX_MODEL,
            claude: this.env.CLAUDE_MODEL,
          });
          const scope: Scope = {
            repo_id: envelope.repo_id,
            job,
            supervisor: crypto.randomUUID() + crypto.randomUUID(),
            model_calls: 0,
            created_at: now(),
          };
          await attemptLog(this.env, scope, 'execution.started');
          if (job.payload?.workspace_transport === 'git-native-v1') {
            if (job.kind === 'agent') {
              const base = job.payload.execution?.base;
              const fork = await provisionAttemptFork(
                this.env,
                envelope.repo_id,
                job,
                base?.repository,
              );
              job.fork = fork;
              scope.fork = fork;
            } else if (job.kind === 'capture') {
              if (job.payload.capture_subtype === 'refresh_candidate') {
                const canonical = job.payload.candidate?.base?.repository;
                const fork = await provisionAttemptFork(
                  this.env,
                  envelope.repo_id,
                  job,
                  canonical,
                  'refresh',
                );
                job.fork = fork;
                scope.fork = fork;
              } else {
                const fork = job.payload.source_revision?.repository;
                if (typeof fork !== 'string')
                  throw new Error('Frozen agent Git revision is missing');
                job.fork = fork;
                scope.fork = fork;
              }
            } else if (job.kind === 'evaluate') {
              scope.fork = job.payload.target?.repository;
            }
          } else if (job.kind === 'capture') {
            const canonical = job.payload.base.repository.split('/')[1];
            const name = `candidate-${(await sha(`${envelope.repo_id}:${job.id}:${job.epoch}`)).slice(0, 32)}`;
            using repo = await this.env.ARTIFACTS.get(canonical);
            try {
              const info = await repo.info();
              // Older imports can have a valid canonical branch different from the metadata.
              // Retain that branch in the fork so capture preserves its ancestry.
              const repository = await ledger(this.env, envelope.repo_id, {
                op: 'repository_status',
              });
              const fork = await repo.fork(name, {
                defaultBranchOnly: repository.remote.branch === info.defaultBranch,
              });
              using target = await this.env.ARTIFACTS.get(name);
              await target.revokeToken(fork.token);
            } catch (e: any) {
              try {
                using existing = await this.env.ARTIFACTS.get(name);
                await existing.info();
              } catch {
                throw e;
              }
            }
            job.fork = `${this.env.ARTIFACTS_NAMESPACE}/${name}`;
            scope.fork = job.fork;
            try {
              await ledger(this.env, envelope.repo_id, {
                op: 'check_attempt',
                job_id: job.id,
                epoch: job.epoch,
              });
            } catch (error: any) {
              if (error.code === 'REPOSITORY_DELETED')
                await cleanupLateRemote(this.env, envelope.repo_id, name);
              throw error;
            }
          }
          const name = await sha(`${envelope.repo_id}:${job.id}:${job.epoch}`);
          await this.env.EXECUTIONS.get(this.env.EXECUTIONS.idFromName(name)).launch(scope);
          message.ack();
        } catch (e: any) {
          writeLog('queue.dispatch_failed', {
            repo_id: envelope.repo_id,
            job_id: envelope.job_id,
            error_code: failureCode(e),
          });
          if (['LEASE_HELD', 'FENCED', 'ATTEMPTS_EXHAUSTED', 'REPOSITORY_DELETED'].includes(e.code))
            message.ack();
          else message.retry({ delaySeconds: 20 });
        }
      }),
    );
  }
}

async function provisionAttemptFork(
  env: Env,
  repoId: string,
  job: Record<string, any>,
  revision?: string,
  purpose = 'attempt',
) {
  const [namespace, canonical, extra] = String(revision ?? '').split('/');
  if (extra || namespace !== env.ARTIFACTS_NAMESPACE || !canonical)
    throw new Error('Approved canonical repository is unavailable');
  const name = `${purpose}-${(await sha(`${repoId}:${job.id}:${job.epoch}`)).slice(0, 32)}`;
  using source = await env.ARTIFACTS.get(canonical);
  try {
    await source.fork(name, { defaultBranchOnly: true });
  } catch (error) {
    try {
      using existing = await env.ARTIFACTS.get(name);
      await existing.info();
    } catch {
      throw error;
    }
  }
  using attempt = await env.ARTIFACTS.get(name);
  for (const token of (await attempt.listTokens()).tokens)
    if (token.state === 'active') await attempt.revokeToken(token.id);
  try {
    await ledger(env, repoId, { op: 'check_attempt', job_id: job.id, epoch: job.epoch });
  } catch (error: any) {
    if (error.code === 'REPOSITORY_DELETED') await cleanupLateRemote(env, repoId, name);
    throw error;
  }
  return `${namespace}/${name}`;
}
