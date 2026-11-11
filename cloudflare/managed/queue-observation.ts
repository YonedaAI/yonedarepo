// Metadata only, on the same message the product already sends.
import { operationCarrier } from '../worker/operation-carrier';
import type { ManagedEnv, QueueMessage } from './config';
export function enqueueManaged(env: ManagedEnv, body: QueueMessage) {
  const observation = env.OPERATION_METRICS === 'on' ? operationCarrier() : undefined;
  return env.RUNS.send(observation ? { ...body, observation, queued_at: Date.now() } : body);
}

import { withCarrier } from '../worker/operation-carrier';
import { observeOperation } from '../worker/operation-observation';
import { inScope } from '../worker/request-scope';
export function observeManagedMessage(
  env: ManagedEnv,
  message: Message<QueueMessage>,
  run: () => Promise<void>,
) {
  return inScope({ env, source: 'queue' }, () =>
    withCarrier(env, message.body.observation, () =>
      observeOperation(
        env,
        {
          kind: 'background',
          source: 'queue',
          operation: `managed.${message.body.kind}`,
          actor: 'system',
          attempt: message.attempts,
          queueWaitMs: Number.isFinite(message.body.queued_at)
            ? Math.max(0, Date.now() - (message.body.queued_at as number))
            : undefined,
        },
        run,
      ),
    ),
  );
}
