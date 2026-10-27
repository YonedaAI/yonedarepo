import { WorkerEntrypoint } from 'cloudflare:workers';
import { authorizeAppPreview, publishedApp } from './apps';
import { refreshCandidate } from './candidate-refresh';
import { captureContribution } from './contribution-capture';
import { now } from './http';
import { attemptLog, failureCode, writeLog } from './logging';
import { deliverOutbox } from './outbox-delivery';
import { enqueueProjects, provisionMessage } from './project-provisioning';
import { fetchRequest } from './routes';
import { modelForJob } from './runtime';
import { beginSandbox } from './sandbox-attempt';
import { beginCheck } from './sandbox-check';
import { captureTeamBranch } from './sandbox-team';
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
          // A sandbox attempt is driven by its own Durable Object: no harness container. A
          // refused start fails the job below (begin is idempotent, so a lost reply is safe).
          if (job.sandbox === true) {
            await beginSandbox(this.env, envelope.repo_id, job);
            message.ack();
            return;
          }
          // A sandbox run's candidate is checked in a fresh check sandbox, not the evaluator.
          if (job.sandbox_check === true) {
            await beginCheck(this.env, envelope.repo_id, job);
            message.ack();
            return;
          }
          // Refreshes and contribution captures are platform commits: no container, no model.
          const platformCapture =
            job.kind === 'capture'
              ? {
                  refresh_candidate: refreshCandidate,
                  platform_commit: captureContribution,
                  sandbox_team: captureTeamBranch,
                }[String(job.payload?.capture_subtype)]
              : undefined;
          if (platformCapture) {
            await ledger(this.env, envelope.repo_id, await platformCapture(this.env, scope));
            message.ack();
            return;
          }
          if (job.payload?.workspace_transport === 'api-source-v1') {
            if ((await prepareSourceDispatch(this.env, scope)) === 'deferred') {
              message.ack();
              return;
            }
          } else
            throw Object.assign(new Error('Only lazy-source attempts run'), {
              code: 'NOT_SUPPORTED',
            });
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
                retryable: ![
                  'INVALID_CAPTURE',
                  'INVALID_INPUT',
                  'FORBIDDEN',
                  'NOT_SUPPORTED',
                ].includes(code),
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
