// Combined deployment (local development): the front Worker and the source platform in one
// Worker. Platform routes and jobs go straight to the platform; everything else is the front.

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AccountCreated } from './account-index';
import { frontFetch } from './front-routes';
import { log, served } from './log';
import { accountCreated } from './platform-accounts';
import { passwordReset, verifyEmail } from './platform-email-verify';
import { oneAtATimeInBatch, platformJob } from './platform-entrypoint';
import { projectHandle } from './platform-handles';
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
  /** The front Worker's handle pick reaches D1 here (account-handles.ts). */
  handleChosen(account: string, handle: string) {
    return projectHandle(this.env, account, handle);
  }
  accountCreated(account: string, details?: AccountCreated) {
    return accountCreated(this.env, account, details);
  }
  verifyEmail(account: string, change?: string) {
    return verifyEmail(this.env, account, change);
  }
  passwordReset(account: string) {
    return passwordReset(this.env, account);
  }
  async queue(batch: MessageBatch<Envelope>) {
    const oneAtATime = oneAtATimeInBatch();
    await Promise.all(
      batch.messages.map((message) =>
        inScope({ env: this.env, job: message.body }, () =>
          platformJob(this.env, message, oneAtATime).catch((e) => {
            log.error('job.failed', { error: e });
            message.retry();
          }),
        ),
      ),
    );
  }
}
