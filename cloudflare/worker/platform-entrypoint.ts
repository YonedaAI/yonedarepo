// Worker entrypoint for the source platform alone: HTTP plus its own queue jobs (checks,
// object and ref projection, derived data). No agent runs, harnesses, providers or budgets.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { platformFetch } from './platform-routes';
import { executeCheckRun } from './repo-checks';
import { deriveAfterLanding } from './repo-derived';
import { projectObjects, projectRefs } from './repo-projection';
import type { Env, Envelope } from './types';

export async function platformJob(env: Env, message: Message<Envelope>) {
  const envelope = message.body;
  if (envelope.kind === 'platform_check') {
    const outcome = await executeCheckRun(env, envelope);
    if (outcome.retry) message.retry({ delaySeconds: outcome.retry });
    else message.ack();
  } else if (envelope.kind === 'platform_project') {
    await projectRefs(env, envelope);
    message.ack();
  } else if (envelope.kind === 'platform_objects') {
    await projectObjects(env, envelope.repo_id);
    message.ack();
  } else if (envelope.kind === 'platform_derive') {
    await deriveAfterLanding(env, envelope);
    message.ack();
  } else message.ack(); // not a platform job
}

export class PlatformEntrypoint extends WorkerEntrypoint<Env> {
  fetch(req: Request) {
    return platformFetch(req, this.env);
  }
  async queue(batch: MessageBatch<Envelope>) {
    for (const message of batch.messages) {
      try {
        await platformJob(this.env, message);
      } catch {
        message.retry();
      }
    }
  }
}
