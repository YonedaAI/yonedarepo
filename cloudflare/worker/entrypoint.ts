// Combined deployment (local development): the front Worker and the source platform in one
// Worker. Platform routes and jobs go straight to the platform; everything else is the front.
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AccountCreated } from './account-index';
import { frontFetch } from './front-routes';
import { log, served } from './log';
import { accountCreated } from './platform-accounts';
import { verifyEmail } from './platform-email-verify';
import { platformJob } from './platform-entrypoint';
import { repoApi } from './repo-api';
import { inScope } from './request-scope';
import type { Env, Envelope } from './types';

export class YonedaEntrypoint extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    const waitUntil = (work: Promise<unknown>) => this.ctx.waitUntil(work);
    return served({ env: this.env, req, waitUntil }, () =>
      new URL(req.url).pathname.startsWith('/api/v1/')
        ? repoApi(req, this.env)
        : frontFetch(req, this.env),
    );
  }
  /** The platform's account-created method (account-email.ts reaches it over SELF). */
  accountCreated(account: string, details?: AccountCreated) {
    return accountCreated(this.env, account, details);
  }
  verifyEmail(account: string, change?: string) {
    return verifyEmail(this.env, account, change);
  }
  async queue(batch: MessageBatch<Envelope>) {
    await Promise.all(
      batch.messages.map((message) =>
        inScope({ env: this.env, job: message.body }, () =>
          platformJob(this.env, message).catch((e) => {
            log.error('job.failed', { error: e });
            message.retry();
          }),
        ),
      ),
    );
  }
}
