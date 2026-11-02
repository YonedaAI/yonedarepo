// Module root of the edge Worker (cloudflare/wrangler.dev-edge.jsonc): unpinned, it runs where a
// request arrives and passes it to the cell it belongs in. It holds no data.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { edgeFetch } from './cell-edge';
import { served } from './log';
import type { Env } from './types';

export default class EdgeEntrypoint extends WorkerEntrypoint<Env> {
  async fetch(req: Request): Promise<Response> {
    const waitUntil = (work: Promise<unknown>) => this.ctx.waitUntil(work);
    return served({ env: this.env, req, waitUntil }, () => edgeFetch(req, this.env));
  }
}
