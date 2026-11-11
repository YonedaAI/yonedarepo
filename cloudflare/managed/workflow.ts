// The durable run: one Cloudflare Workflow definition for every agent, one instance per (run,
// attempt). Steps retry on their own and a restarted instance resumes after its last finished
// step; the harness container keeps running between polls, so a lost isolate costs nothing.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { withCarrier } from '../worker/operation-carrier';
import { observeOperation } from '../worker/operation-observation';
import type { ManagedEnv, RunParams } from './config';
import { runAgent, type Steps } from './run';

/** Starting a container may wait for capacity: retried with backoff for about ten minutes. */
const START_STEP = {
  retries: { limit: 8, delay: '15 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;
const STEP = {
  retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} as const;

export const instanceId = (run: string, attempt: number) => `${run}-${attempt}`;

export class ManagedReviewWorkflow extends WorkflowEntrypoint<ManagedEnv, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const steps: Steps = {
      // Step results are plain JSON objects; the cast drops workers-types' Serializable bound.
      do: (name, fn) =>
        (step.do as any)(name, name.startsWith('start-') ? START_STEP : STEP, () =>
          withCarrier(this.env, event.payload.observation, () =>
            observeOperation(
              this.env,
              {
                kind: 'background',
                source: 'workflow',
                actor: 'system',
                operation: `managed.${['admit', 'prepare', 'start', 'poll', 'collect', 'post', 'pause'].includes(name.split('-')[0]) ? name.split('-')[0] : 'step'}`,
                attempt: event.payload.attempt,
              },
              fn,
            ),
          ),
        ),
      sleep: (name, ms) => step.sleep(name, ms),
    };
    return withCarrier(this.env, event.payload.observation, () =>
      runAgent(this.env, event.payload, steps),
    );
  }
}
