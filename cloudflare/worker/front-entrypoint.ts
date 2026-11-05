// The front Worker's entrypoint: the browser app and account sign-in in front of the source
// platform, which it reaches only through the PLATFORM service binding (`/api/v1`) and the
// WORKSPACES script binding (accounts).
import { WorkerEntrypoint } from 'cloudflare:workers';
import { frontFetch } from './front-routes';
import { served } from './log';
import { responseTimed } from './response-timing';
import type { Env } from './types';

export class FrontEntrypoint extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    const waitUntil = (work: Promise<unknown>) => this.ctx.waitUntil(work);
    return served({ env: this.env, req, waitUntil }, () =>
      responseTimed(this.env, () => frontFetch(req, this.env)),
    );
  }
}
