// The durable run: one Cloudflare Workflow instance per (run, attempt). Steps retry on their
// own and a restarted instance resumes after its last finished step, so a model call that
// already settled is never made (or charged) twice.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { ManagedEnv, RunParams } from './config';
import { runReview, type Steps } from './review';

const MODEL_STEP = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '3 minutes',
} as const;
const PLATFORM_STEP = {
  retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} as const;

export const instanceId = (run: string, attempt: number) => `${run}-${attempt}`;

export class ManagedReviewWorkflow extends WorkflowEntrypoint<ManagedEnv, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const steps: Steps = {
      do: (name, fn) =>
        // Step results are plain JSON objects; the cast drops workers-types' Serializable bound.
        (step.do as any)(
          name,
          name === 'summarise' || name === 'rank' || name.startsWith('review-')
            ? MODEL_STEP
            : PLATFORM_STEP,
          fn,
        ),
    };
    return runReview(this.env, event.payload, steps);
  }
}
