// Durable import pipeline (Cloudflare Workflows): each step of a clone retries independently and
// its result is persisted, so a failure resumes where it stopped.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { cellEnv } from './cell-env';
import { type CloneParams, cloneRepository } from './repo-clone';
import type { Env } from './types';

export class PlatformImportWorkflow extends WorkflowEntrypoint<Env, CloneParams> {
  run(event: WorkflowEvent<CloneParams>, step: WorkflowStep) {
    return cloneRepository(cellEnv(this.env), event.payload, step as never);
  }
}
