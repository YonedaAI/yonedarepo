// Durable import pipeline (Cloudflare Workflows): each step of runImport retries
// independently and its result is persisted, so a failure resumes where it stopped.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { type ImportParams, runImport } from './repo-import';
import { dispatchProjection } from './repo-projection';
import type { Env } from './types';

export class PlatformImportWorkflow extends WorkflowEntrypoint<Env, ImportParams> {
  async run(event: WorkflowEvent<ImportParams>, step: WorkflowStep) {
    const result = await runImport(this.env, event.payload, step as never);
    await step.do('project refs', async () => {
      await dispatchProjection(this.env, event.payload.repo);
      return true;
    });
    return result;
  }
}
