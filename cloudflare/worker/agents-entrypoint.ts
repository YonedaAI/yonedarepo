import { WorkerEntrypoint } from 'cloudflare:workers';
import { authorizeAppPreview, publishedApp } from './apps';
import { comparisonReviewAttempt } from './comparison-scope';
import { now } from './http';
import { attemptLog, failureCode, writeLog } from './logging';
import { deliverOutbox } from './outbox-delivery';
import { enqueueProjects, provisionMessage } from './project-provisioning';
import { cleanupLateRemote } from './repository-deletion';
import { fetchRequest } from './routes';
import { modelForJob } from './runtime';
import { authorizePreview } from './sites';
import type { SourceGcDue, SourceIndexEnvelope } from './source-contract';
import { prepareSourceDispatch } from './source-dispatch';
import { sourceIndex } from './source-index-queue';
import { sourceCleanup } from './source-storage';
import { ledger, sha } from './storage';
import type { Env, Envelope, Json, Scope } from './types';
/** The agent layer's Worker entrypoint: runs, harness containers and their queues. It reaches
 * the source platform only through its public HTTP API (`routes.ts`). */
export class AgentsEntrypoint extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    return fetchRequest(req, this.env, this.ctx);
  }

  async authorizePreview(digest: string, token: string) {
    return authorizePreview(this.env, digest, token);
  }
  async authorizeAppPreview(preview: string, token: string) {
    return authorizeAppPreview(this.env, preview, token);
  }
  async publishedApp(repo: string) {
    return publishedApp(this.env, repo);
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
  async sourceCleanup(due: SourceGcDue) {
    return sourceCleanup(this.env, due);
  }

  /** Platform jobs belong to the platform Worker; a combined deployment overrides this. */
  protected async platformMessage(message: Message<Envelope>) {
    writeLog('queue.foreign_platform_job', {
      repo_id: message.body.repo_id,
      stage: message.body.kind,
    });
    message.ack();
  }

  protected async launchExecution(name: string, scope: Scope) {
    await this.env.EXECUTIONS.get(this.env.EXECUTIONS.idFromName(name)).launch(scope);
  }

  async queue(batch: MessageBatch<Envelope>) {
    await Promise.all(
      batch.messages.map(async (message) => {
        const envelope = message.body;
        let claimed: { id: string; epoch: number } | undefined;
        let launchRequested = false;
        try {
          if (envelope.v !== 1) {
            message.ack();
            return;
          }
          if (envelope.kind.startsWith('platform_')) {
            await this.platformMessage(message);
            return;
          }
          if (envelope.kind === 'provision') {
            await provisionMessage(this.env, message);
            return;
          }
          if (envelope.kind === 'source_index') {
            const indexed = await sourceIndex(this.env, envelope as SourceIndexEnvelope);
            if (indexed.state === 'preparing')
              await this.env.AGENT_QUEUE.send(envelope, { delaySeconds: 1 });
            message.ack();
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
          claimed = { id: String(job.id), epoch: Number(job.epoch) };
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
          if (job.payload?.workspace_transport === 'api-source-v1') {
            if ((await prepareSourceDispatch(this.env, scope)) === 'deferred') {
              message.ack();
              return;
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
          launchRequested = true;
          await this.launchExecution(name, scope);
          message.ack();
        } catch (e: any) {
          const code = failureCode(e);
          writeLog('queue.dispatch_failed', {
            repo_id: envelope.repo_id,
            job_id: envelope.job_id,
            error_code: code,
          });
          if (claimed && !launchRequested) {
            try {
              await ledger(this.env, envelope.repo_id, {
                op: 'fail',
                job_id: claimed.id,
                epoch: claimed.epoch,
                error: `Queue dispatch failed (${code})`,
                retryable: !['INVALID_CAPTURE', 'INVALID_INPUT', 'FORBIDDEN'].includes(code),
              });
              // The ledger now owns retry delivery through its transactional outbox.
              message.ack();
            } catch (dispositionError: any) {
              if (
                ['LEASE_HELD', 'FENCED', 'ATTEMPTS_EXHAUSTED', 'REPOSITORY_DELETED'].includes(
                  dispositionError.code,
                )
              )
                message.ack();
              else message.retry({ delaySeconds: 20 });
            }
            return;
          }
          if (['LEASE_HELD', 'FENCED', 'ATTEMPTS_EXHAUSTED', 'REPOSITORY_DELETED'].includes(code))
            message.ack();
          else message.retry({ delaySeconds: 20 });
        }
      }),
    );
  }
}
