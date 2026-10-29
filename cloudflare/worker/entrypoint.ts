// Combined deployment (local development): the front Worker and the source platform in one
// Worker. Platform routes and jobs go straight to the platform; everything else is the front.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { withWaitUntil } from './background';
import { frontFetch } from './front-routes';
import { platformJob } from './platform-entrypoint';
import { queueWelcome } from './platform-welcome-email';
import { repoApi } from './repo-api';
import type { Env, Envelope } from './types';

export class YonedaEntrypoint extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    return withWaitUntil(
      (work) => this.ctx.waitUntil(work),
      () =>
        new URL(req.url).pathname.startsWith('/api/v1/')
          ? repoApi(req, this.env)
          : frontFetch(req, this.env),
    );
  }
  /** The platform's account-created method (account-email.ts reaches it over SELF). */
  accountCreated(account: string) {
    return queueWelcome(this.env, account);
  }
  async queue(batch: MessageBatch<Envelope>) {
    await Promise.all(
      batch.messages.map((message) => platformJob(this.env, message).catch(() => message.retry())),
    );
  }
}
