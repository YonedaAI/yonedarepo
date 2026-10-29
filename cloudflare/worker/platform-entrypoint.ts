// Worker entrypoint for the source platform alone: HTTP, Git over SSH's front doors (inbound
// TCP and the tunnel gateway's keep-alive cron; platform-ssh-gateway.ts), plus its own queue
// jobs (checks, object and ref projection, derived data, webhooks, account emails). No agent runs, harnesses, providers or budgets.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { welcomeJob } from './account-email';
import { withWaitUntil } from './background';
import { platformFetch } from './platform-routes';
import { sshFrontDoor, sshKeepAlive } from './platform-ssh-gateway';
import { purgeRepository } from './repo-admin';
import { executeCheckRun } from './repo-checks';
import { deriveAfterLanding } from './repo-derived';
import { hookJob } from './repo-hooks';
import { lfsSweepJob } from './repo-lfs-sweep';
import { projectObjects, projectRefs } from './repo-projection';
import type { Env, Envelope } from './types';

export async function platformJob(env: Env, message: Message<Envelope>) {
  const envelope = message.body;
  if (envelope.kind === 'platform_check') {
    await executeCheckRun(env, envelope);
    message.ack();
  } else if (envelope.kind === 'platform_project') {
    const outcome = await projectRefs(env, envelope, message.attempts);
    if (outcome.retry) message.retry({ delaySeconds: outcome.retry });
    else message.ack();
  } else if (envelope.kind === 'platform_objects') {
    await projectObjects(env, envelope.repo_id, envelope.job_id);
    message.ack();
  } else if (envelope.kind === 'platform_derive') {
    await deriveAfterLanding(env, envelope);
    message.ack();
  } else if (envelope.kind === 'platform_hooks') {
    const outcome = await hookJob(env, envelope);
    if (outcome.retry) message.retry({ delaySeconds: outcome.retry });
    else message.ack();
  } else if (envelope.kind === 'platform_lfs_sweep') {
    await lfsSweepJob(env, envelope);
    message.ack();
  } else if (envelope.kind === 'platform_purge') {
    await purgeRepository(env, envelope.repo_id);
    message.ack();
  } else if (envelope.kind === 'account_welcome') {
    const outcome = await welcomeJob(env, envelope, message.attempts);
    if (outcome.retry) message.retry({ delaySeconds: outcome.retry });
    else message.ack();
  } else message.ack(); // not a platform job
}

export class PlatformEntrypoint extends WorkerEntrypoint<Env> {
  fetch(req: Request) {
    return withWaitUntil(
      (work) => this.ctx.waitUntil(work),
      () => platformFetch(req, this.env),
    );
  }
  /** Inbound TCP: Git over SSH, through the SSH gateway container. */
  connect(socket: Socket) {
    return sshFrontDoor(socket, this.env);
  }
  /** Every minute: keeps the SSH gateway (and its tunnel) running. */
  scheduled() {
    return sshKeepAlive(this.env, 'cron');
  }
  /** Jobs of a batch run side by side (they wait on I/O, not CPU); each settles alone. */
  async queue(batch: MessageBatch<Envelope>) {
    await Promise.all(
      batch.messages.map((message) =>
        platformJob(this.env, message).catch((e) => {
          // Which job failed and why, for `wrangler tail`; the queue retries it.
          const { kind, repo_id, job_id } = message.body;
          const error = String(e?.message ?? e).slice(0, 200);
          console.error(JSON.stringify({ event: 'job.failed', kind, repo_id, job_id, error }));
          message.retry();
        }),
      ),
    );
  }
}
