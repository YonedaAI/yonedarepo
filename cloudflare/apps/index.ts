import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AppsEnv } from './host';
import { serveApp } from './host';

export { AppRunner } from './runner';
/** Separate Worker origin; production platform wiring is owned by the parent. */
export default class AppsEntrypoint extends WorkerEntrypoint<AppsEnv> {
  async fetch(request: Request) {
    return serveApp(request, this.env);
  }
}
