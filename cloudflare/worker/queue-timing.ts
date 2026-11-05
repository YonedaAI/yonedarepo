// Queue age includes intentional producer delays. Measure only time after eligibility.

export const QUEUE_WAIT_BUDGET_MS = 120_000;
export const queueDelay = (options?: { delaySeconds?: number }) =>
  Math.max(0, options?.delaySeconds ?? 0) * 1000;

/** Old envelopes are unknown, not zero. Retries have separate failure/retry signals.
 * Use the queue's enqueue timestamp, avoiding clock skew between producer and consumer. */
export function readyWait(
  message: Pick<Message<{ queue_delay_ms?: number }>, 'body' | 'timestamp' | 'attempts'>,
  now = Date.now(),
): number | null {
  const delay = message.body?.queue_delay_ms;
  if (
    message.attempts !== 1 ||
    typeof delay !== 'number' ||
    !Number.isSafeInteger(delay) ||
    delay < 0 ||
    delay > 43_200_000
  )
    return null;
  return Math.max(0, now - message.timestamp.getTime() - delay);
}
