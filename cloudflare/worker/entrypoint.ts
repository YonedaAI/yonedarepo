// Combined deployment: the agent layer and the source platform in one Worker. Platform
// routes and jobs go straight to the platform; everything else is the agent layer.
import { AgentsEntrypoint } from './agents-entrypoint';
import { platformJob } from './platform-entrypoint';
import { repoApi } from './repo-api';
import type { Envelope } from './types';

export class YonedaEntrypoint extends AgentsEntrypoint {
  override async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname.startsWith('/api/v1/')) return repoApi(req, this.env);
    return super.fetch(req);
  }
  protected override async platformMessage(message: Message<Envelope>) {
    await platformJob(this.env, message);
  }
}
