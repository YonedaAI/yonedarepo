// Durable import pipeline (Cloudflare Workflows): each step of a clone retries independently and
// its result is persisted, so a failure resumes where it stopped.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { cellEnv } from './cell-env';
import { withCarrier } from './operation-carrier';
import { observeOperation } from './operation-observation';
import { type CloneParams, type CloneStep, cloneRepository } from './repo-clone';
import type { Env } from './types';

export class PlatformImportWorkflow extends WorkflowEntrypoint<Env, CloneParams> {
  run(event: WorkflowEvent<CloneParams>, step: WorkflowStep) {
    const env = cellEnv(this.env);
    const observed: CloneStep = {
      do: (name, config, run) =>
        (step as unknown as CloneStep).do(name, config, () =>
          withCarrier(env, event.payload.observation, () =>
            observeOperation(
              env,
              {
                kind: 'background',
                source: 'workflow',
                operation: 'import.step',
                actor: 'system',
                repo: event.payload.repo,
              },
              run,
            ),
          ),
        ),
    };
    return withCarrier(env, event.payload.observation, () =>
      cloneRepository(env, event.payload, observed),
    );
  }
}
