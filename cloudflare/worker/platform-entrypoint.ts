// Worker entrypoint for the source platform alone: HTTP, Git over SSH's front doors (inbound
// TCP and the tunnel gateway's keep-alive cron; platform-ssh-gateway.ts), plus its own queue
// jobs (checks, store creation, object and ref projection, derived data, clone packs, webhooks,
// clearance, account emails, the Flight log's confirmations, the operators' sign-up notice). No agent runs, harnesses, providers
// or budgets.

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AccountCreated } from './account-index';
import { cellEnv } from './cell-env';
import { internalAccounts } from './internal-accounts';
import { log, served } from './log';
import { type OperationCarrier, withCarrier } from './operation-carrier';
import { markOperationOutcome, observeOperation, observeRequest } from './operation-observation';
import { closeCell, unlist } from './platform-account-close';
import { closurePart } from './platform-account-close-part';
import { accountCreated, SIGNUP_NOTICE } from './platform-accounts';
import { nightlyReconcile } from './platform-admin-billing';
import { passwordReset, verifyEmail } from './platform-email-verify';
import { projectHandle } from './platform-handles';
import { settleFailedJob } from './platform-job-settle';
import { laterIfHeld } from './platform-legal-hold';
import { NEWSLETTER_JOB, sweepNewsletter } from './platform-newsletter';
import { newsletterJob } from './platform-newsletter-email';
import { memberNotificationJob } from './platform-org-notifications';
import { passwordResetJob } from './platform-password-email';
import { platformFetch } from './platform-routes';
import { signupNoticeJob } from './platform-signup-notice';
import { sshFrontDoor, sshKeepAlive } from './platform-ssh-gateway';
import { visitorSalt } from './platform-visitor-salt';
import { welcomeJob } from './platform-welcome-email';
import { QUEUE_WAIT_BUDGET_MS, readyWait } from './queue-timing';
import { ERASE, purgeJob } from './repo-admin';
import { executeCheckRun } from './repo-checks';
import { CLASSIFY, classifyJob } from './repo-classify';
import { COMPACT_JOB, compactionJob, sweepCompaction } from './repo-compaction';
import { sweepDeleted } from './repo-deleted';
import { deriveAfterLanding } from './repo-derived';
import { eraseJob } from './repo-erase';
import { hookJob } from './repo-hooks';
import { LAND_CHECK } from './repo-land-check';
import { landCheckJob } from './repo-land-cleared';
import { lfsSweepJob } from './repo-lfs-sweep';
import { PACK_BUILD, packBuildJob } from './repo-pack-jobs';
import { projectObjects } from './repo-projection';
import { quarantineJob } from './repo-quarantine';
import { SUMMARY_JOB, summaryJob } from './repo-search-summary';
import { inScope } from './request-scope';
import type { Env, Envelope } from './types';

/** Jobs that hold a large push's objects (projection to the object stores, derived data,
 * clone packs) run one at a time in a batch: side by side, a batch of them exceeded its 128 MB
 * (dev, 2026-10-29: 17 queue invocations killed for memory in ten minutes of size-ladder pushes).
 * The chain belongs to one batch, never the isolate: Workers drops a continuation whose request
 * has ended, so a chain shared across invocations hung every heavy job after one cancelled batch,
 * and each hung batch ended in an exception with no log (dev, 2026-11-01: over 600 dead letters). */
export function oneAtATimeInBatch() {
  let heavy: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = heavy.then(work, work);
    heavy = run.catch(() => {}); // The batch's next job runs anyway; `run`'s caller has the failure.
    return run;
  };
}

function acknowledge(message: Message<Envelope>) {
  message.ack();
  markOperationOutcome('ok');
}
function retryMessage(message: Message<Envelope>, options: { delaySeconds?: number }) {
  message.retry(options);
  markOperationOutcome('retry');
}

export async function platformJob(
  env: Env,
  message: Message<Envelope>,
  oneAtATime = oneAtATimeInBatch(),
) {
  const envelope = message.body;
  if (envelope.kind === 'platform_check') {
    await executeCheckRun(env, envelope);
    acknowledge(message);
  } else if (envelope.kind === 'platform_objects') {
    await oneAtATime(() => projectObjects(env, envelope.repo_id, envelope.job_id));
    acknowledge(message);
  } else if (envelope.kind === 'platform_derive') {
    await oneAtATime(() => deriveAfterLanding(env, envelope));
    acknowledge(message);
  } else if (envelope.kind === SUMMARY_JOB) {
    await oneAtATime(() => summaryJob(env, envelope));
    acknowledge(message);
  } else if (envelope.kind === CLASSIFY) {
    await oneAtATime(() => classifyJob(env, envelope));
    acknowledge(message);
  } else if (envelope.kind === PACK_BUILD) {
    await oneAtATime(() => packBuildJob(env, envelope));
    acknowledge(message);
  } else if (envelope.kind === COMPACT_JOB) {
    await oneAtATime(() => compactionJob(env, envelope));
    acknowledge(message);
  } else if (envelope.kind === 'platform_hooks') {
    const outcome = await hookJob(env, envelope);
    if (outcome.retry) retryMessage(message, { delaySeconds: outcome.retry });
    else acknowledge(message);
  } else if (envelope.kind === LAND_CHECK) {
    const outcome = await landCheckJob(env, envelope, message.attempts);
    if (outcome.retry) retryMessage(message, { delaySeconds: outcome.retry });
    else acknowledge(message);
  } else if (envelope.kind === 'platform_lfs_sweep') {
    await lfsSweepJob(env, envelope);
    acknowledge(message);
  } else if (envelope.kind === 'platform_quarantine') {
    await laterIfHeld(env, envelope, () => quarantineJob(env, envelope));
    acknowledge(message);
  } else if (envelope.kind === 'platform_purge') {
    await purgeJob(env, envelope);
    acknowledge(message);
  } else if (envelope.kind === ERASE) {
    await laterIfHeld(env, envelope, () => eraseJob(env, envelope));
    acknowledge(message);
  } else if (envelope.kind === SIGNUP_NOTICE) {
    const outcome = await signupNoticeJob(env, envelope, message.attempts);
    if (outcome.retry) retryMessage(message, { delaySeconds: outcome.retry });
    else acknowledge(message);
  } else if (envelope.kind === 'org_member_notification') {
    const outcome = await memberNotificationJob(env, envelope);
    if (outcome.retry) retryMessage(message, { delaySeconds: outcome.retry });
    else acknowledge(message);
  } else if (envelope.kind === 'account_welcome' || envelope.kind === 'account_verify') {
    const outcome = await welcomeJob(env, envelope, message.attempts);
    if (outcome.retry) retryMessage(message, { delaySeconds: outcome.retry });
    else acknowledge(message);
  } else if (envelope.kind === 'account_password_reset') {
    const outcome = await passwordResetJob(env, envelope, message.attempts);
    if (outcome.retry) retryMessage(message, { delaySeconds: outcome.retry });
    else acknowledge(message);
  } else if (envelope.kind === NEWSLETTER_JOB) {
    const outcome = await newsletterJob(env, envelope, message.attempts);
    if (outcome.retry) retryMessage(message, { delaySeconds: outcome.retry });
    else acknowledge(message);
  } else acknowledge(message); // not a platform job
}

export class PlatformEntrypoint extends WorkerEntrypoint<Env> {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, cellEnv(env));
  }

  fetch(req: Request) {
    const waitUntil = (work: Promise<unknown>) => this.ctx.waitUntil(work);
    return served({ env: this.env, req, waitUntil }, () =>
      observeRequest(this.env, req, () => platformFetch(req, this.env)),
    );
  }
  /** Inbound TCP: Git over SSH, through the SSH gateway container. */
  connect(socket: Socket) {
    return sshFrontDoor(socket, this.env);
  }
  /** A new account (RPC from the front Worker, or SELF): indexes it, queues the operators'
   * sign-up notice and its welcome email. Not on any HTTP route, so only Workers bound to
   * this one can ask. */
  /** The front Worker's handle pick reaches D1 here (account-handles.ts). */
  handleChosen(account: string, handle: string) {
    return projectHandle(this.env, account, handle);
  }
  accountCreated(account: string, details?: AccountCreated, observation?: OperationCarrier) {
    return withCarrier(this.env, observation, () =>
      observeOperation(this.env, { kind: 'request', operation: 'account.accountCreated' }, () =>
        accountCreated(this.env, account, details),
      ),
    );
  }
  /** The accounts that are ours (RPC from the front Worker, which has no D1), for leaving them
   * out of the site's figures. */
  async internalAccounts() {
    return (await internalAccounts(this.env)) ?? [];
  }
  /** The day's salt for the visitor hash (RPC, as above). */
  visitorSalt(day: string) {
    return visitorSalt(this.env, day);
  }
  /** Settings' resend (no `change`) or address change for a signed-in account (RPC, as
   * above): a new confirmation token and email, or why not. */
  verifyEmail(account: string, change?: string, observation?: OperationCarrier) {
    return withCarrier(this.env, observation, () =>
      observeOperation(this.env, { kind: 'request', operation: 'account.verifyEmail' }, () =>
        verifyEmail(this.env, account, change),
      ),
    );
  }
  /** What deleting an account takes in this cell, and doing it (RPC from the cell closing it). */
  closurePart(account: string) {
    return closurePart(this.env, account);
  }
  closeCell(account: string) {
    return closeCell(this.env, account);
  }
  unlistCell(account: string) {
    return unlist(this.env, account);
  }
  /** A forgotten password's link, or nothing (RPC, as above). */
  passwordReset(account: string, observation?: OperationCarrier) {
    return withCarrier(this.env, observation, () =>
      observeOperation(this.env, { kind: 'request', operation: 'account.passwordReset' }, () =>
        passwordReset(this.env, account),
      ),
    );
  }
  /** Every minute: keeps the SSH gateway (and its tunnel) running, sends the purges that
   * came due and this minute's compaction jobs; once a night, starts the billing reconcile and
   * forgets unconfirmed Flight log addresses.
   * None stops the others. */
  async scheduled(controller: ScheduledController) {
    const logged = (event: string) => (e: unknown) => log.error(event, { error: e });
    await inScope({ env: this.env, source: 'cron' }, () =>
      Promise.all([
        observeOperation(
          this.env,
          { kind: 'background', source: 'cron', actor: 'system', operation: 'ssh_keepalive' },
          () => sshKeepAlive(this.env, 'cron'),
        ),
        observeOperation(
          this.env,
          { kind: 'background', source: 'cron', actor: 'system', operation: 'purge_due' },
          () => sweepDeleted(this.env),
        ).catch(logged('undo.sweep_failed')),
        observeOperation(
          this.env,
          { kind: 'background', source: 'cron', actor: 'system', operation: 'compaction_due' },
          () => sweepCompaction(this.env),
        ).catch(logged('compaction.sweep_failed')),
        observeOperation(
          this.env,
          { kind: 'background', source: 'cron', actor: 'system', operation: 'billing_reconcile' },
          () => nightlyReconcile(this.env, controller.scheduledTime),
        ).catch(logged('billing.reconcile_failed')),
        observeOperation(
          this.env,
          { kind: 'background', source: 'cron', actor: 'system', operation: 'newsletter_cleanup' },
          () => sweepNewsletter(this.env, controller.scheduledTime),
        ).catch(logged('newsletter.sweep_failed')),
      ]),
    );
  }
  /** Jobs of a batch run side by side (they wait on I/O, not CPU; heavy ones one at a
   * time: `oneAtATime`); each settles alone. */
  async queue(batch: MessageBatch<Envelope>) {
    const oneAtATime = oneAtATimeInBatch();
    await Promise.all(
      batch.messages.map((message) =>
        inScope({ env: this.env, job: message.body }, () => {
          const waited = readyWait(message);
          if (waited !== null && waited > QUEUE_WAIT_BUDGET_MS)
            log.warn('queue.late', { ms: waited });
          return withCarrier(this.env, message.body.observation, () =>
            observeOperation(
              this.env,
              {
                kind: 'background',
                source: 'queue',
                actor: 'system',
                operation: message.body.kind,
                repo: message.body.repo_id,
                attempt: message.attempts,
                queueWaitMs: waited ?? undefined,
              },
              () => platformJob(this.env, message, oneAtATime),
            ),
          ).catch((e) => settleFailedJob(message, e));
        }),
      ),
    );
  }
}
