// Calls into the platform's Durable Objects. A call that fails because the instance was
// reset (a deploy, an eviction) is retried once on a fresh stub, as Cloudflare advises; the
// platform's commands are idempotent (records, adoptions, landings and enqueues answer
// "already" on a repeat), so a call that did run before the reset is safe to repeat.
const RESET = /no longer active|Network connection lost|reset because its code was updated/i;
const OVERLOAD = /overloaded|queued for too long|too many requests queued/i;

/** Seconds a client waits before retrying a request the platform was too busy to serve. */
export const RETRY_AFTER_SECONDS = 1;

/**
 * A failure that says nothing about the request: a Durable Object overloaded, reset or
 * briefly unreachable (Cloudflare marks these `.overloaded` or `.retryable`). The same
 * request can succeed later. Platform answers carry a string `code` and never count.
 */
export function transient(e: any): boolean {
  if (typeof e?.code === 'string') return false;
  const message = String(e?.message ?? e);
  return (
    e?.overloaded === true || e?.retryable === true || OVERLOAD.test(message) || RESET.test(message)
  );
}

/** The API code of a failure: the platform's own, OVERLOADED when transient, else INTERNAL
 * (an unexpected failure is the platform's fault, never the caller's input). */
export function failureCode(e: any): string {
  if (typeof e?.code === 'string' && e.code) return e.code;
  return transient(e) ? 'OVERLOADED' : 'INTERNAL';
}

export async function durableJson<T = Record<string, any>>(
  stub: () => DurableObjectStub,
  url: string,
  body: string,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await stub().fetch(url, { method: 'POST', body });
      return await response.json<T>();
    } catch (e: any) {
      if (attempt > 0 || !(e?.retryable === true || RESET.test(String(e?.message ?? e)))) throw e;
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }
}
