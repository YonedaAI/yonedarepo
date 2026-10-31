// Worker entrypoint for the source platform alone: HTTP, Git over SSH's front doors (inbound
// TCP and the tunnel gateway's keep-alive cron; platform-ssh-gateway.ts), plus its own queue
// jobs (checks, store creation, object and ref projection, derived data, clone packs, webhooks,
// clearance, account emails, the operators' sign-up notice). No agent runs, harnesses, providers
// or budgets.
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AccountCreated } from './account-index';
import { withWaitUntil } from './background';
import { accountCreated, SIGNUP_NOTICE } from './platform-accounts';
import { nightlyReconcile } from './platform-admin-billing';
import { verifyEmail } from './platform-email-verify';
import { laterIfHeld } from './platform-legal-hold';
import { platformFetch } from './platform-routes';
import { signupNoticeJob } from './platform-signup-notice';
import { sshFrontDoor, sshKeepAlive } from './platform-ssh-gateway';
import { welcomeJob } from './platform-welcome-email';
import { ERASE, purgeJob } from './repo-admin';
import { STORE_JOB } from './repo-artifacts-store';
import { executeCheckRun } from './repo-checks';
import { CLASSIFY, classifyJob } from './repo-classify';
import { sweepDeleted } from './repo-deleted';
import { deriveAfterLanding } from './repo-derived';
import { eraseJob } from './repo-erase';
import { hookJob } from './repo-hooks';
import { LAND_CHECK } from './repo-land-check';
import { landCheckJob } from './repo-land-cleared';
import { lfsSweepJob } from './repo-lfs-sweep';
import { PACK_BUILD, packBuildJob } from './repo-pack-jobs';
import { projectObjects, projectRefs } from './repo-projection';
import { quarantineJob } from './repo-quarantine';
import { SUMMARY_JOB, summaryJob } from './repo-search-summary';
import { storeAwaited, storeJob } from './repo-store-create';
import type { Env, Envelope } from './types';

/** Jobs that hold a large push's objects (projection to the object stores, derived data,
 * clone packs) run one at a time in an isolate: side by side, a batch of them exceeded its 128 MB (dev,
 * 2026-10-29: 17 queue invocations killed for memory in ten minutes of size-ladder pushes). */
let heavy: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = heavy.then(work, work);
  heavy = run.catch(() => {});
  return run;
}

export async function platformJob(env: Env, message: Message<Envelope>) {
  const envelope = message.body;
  if (envelope.kind === 'platform_check') {
    await executeCheckRun(env, envelope);
    message.ack();
  } else if (envelope.kind === 'platform_project') {
    const outcome = await oneAtATime(() =>
      storeAwaited(() => projectRefs(env, envelope, message.attempts)),
    );
    if (outcome.retry) message.retry({ delaySeconds: outcome.retry });
    else message.ack();
  } else if (envelope.kind === STORE_JOB) {
    await storeJob(env, envelope);
    message.ack();
  } else if (envelope.kind === 'platform_objects') {
    await oneAtATime(() => projectObjects(env, envelope.repo_id, envelope.job_id));
    message.ack();
  } else if (envelope.kind === 'platform_derive') {
    await oneAtATime(() => deriveAfterLanding(env, envelope));
    message.ack();
  } else if (envelope.kind === SUMMARY_JOB) {
    await oneAtATime(() => summaryJob(env, envelope));
    message.ack();
  } else if (envelope.kind === CLASSIFY) {
    await oneAtATime(() => classifyJob(env, envelope));
    message.ack();
  } else if (envelope.kind === PACK_BUILD) {
    await oneAtATime(() => packBuildJob(env, envelope));
    message.ack();
  } else if (envelope.kind === 'platform_hooks') {
    const outcome = await hookJob(env, envelope);
    if (outcome.retry) message.retry({ delaySeconds: outcome.retry });
    else message.ack();
  } else if (envelope.kind === LAND_CHECK) {
    const outcome = await landCheckJob(env, envelope, message.attempts);
    if (outcome.retry) message.retry({ delaySeconds: outcome.retry });
    else message.ack();
  } else if (envelope.kind === 'platform_lfs_sweep') {
    await lfsSweepJob(env, envelope);
    message.ack();
  } else if (envelope.kind === 'platform_quarantine') {
    await laterIfHeld(env, envelope, () => quarantineJob(env, envelope));
    message.ack();
  } else if (envelope.kind === 'platform_purge') {
    await purgeJob(env, envelope);
    message.ack();
  } else if (envelope.kind === ERASE) {
    await laterIfHeld(env, envelope, () => eraseJob(env, envelope));
    message.ack();
  } else if (envelope.kind === SIGNUP_NOTICE) {
    const outcome = await signupNoticeJob(env, envelope, message.attempts);
    if (outcome.retry) message.retry({ delaySeconds: outcome.retry });
    else message.ack();
  } else if (envelope.kind === 'account_welcome' || envelope.kind === 'account_verify') {
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
  /** A new account (RPC from the front Worker, or SELF): indexes it, queues the operators'
   * sign-up notice and its welcome email. Not on any HTTP route, so only Workers bound to
   * this one can ask. */
  accountCreated(account: string, details?: AccountCreated) {
    return accountCreated(this.env, account, details);
  }
  /** Settings' resend (no `change`) or address change for a signed-in account (RPC, as
   * above): a new confirmation token and email, or why not. */
  verifyEmail(account: string, change?: string) {
    return verifyEmail(this.env, account, change);
  }
  /** Every minute: keeps the SSH gateway (and its tunnel) running and sends the purges that
   * came due; once a night, starts the billing reconcile. None stops the others. */
  async scheduled(controller: ScheduledController) {
    const logged = (event: string) => (e: unknown) => {
      const error = String((e as Error)?.message ?? e).slice(0, 200);
      console.error(JSON.stringify({ event, error }));
    };
    await Promise.all([
      sshKeepAlive(this.env, 'cron'),
      sweepDeleted(this.env).catch(logged('undo.sweep_failed')),
      nightlyReconcile(this.env, controller.scheduledTime).catch(
        logged('billing.reconcile_failed'),
      ),
    ]);
  }
  /** Jobs of a batch run side by side (they wait on I/O, not CPU; heavy ones one at a
   * time: `oneAtATime`); each settles alone. */
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
