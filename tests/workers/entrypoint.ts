export { WorkspaceAuthority, SourceRepository, CommitShard, RepositoryReadCopy } from '../../backend/crates/yoneda-worker/build/index.js';
export { YonedaEntrypoint as default } from '../../cloudflare/worker/entrypoint';
export { LandCombiner } from '../../cloudflare/worker/repo-land-combiner';

import { WorkerEntrypoint } from 'cloudflare:workers';

/** Test-only HTTP service target: proves metadata crosses a real workerd binding. */
export class GeographyEcho extends WorkerEntrypoint {
  async fetch(req: Request) {
    return Response.json({ continent: req.cf?.continent, colo: req.cf?.colo, method: req.method, body: req.method === 'POST' ? await req.json() : null });
  }
}

export { DurableFlightsFixture } from './durable-flights-fixture';
