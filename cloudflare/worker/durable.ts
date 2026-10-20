// Calls into the platform's Durable Objects. A call that fails because the instance was
// reset (a deploy, an eviction) is retried once on a fresh stub, as Cloudflare advises; the
// platform's commands are idempotent (records, adoptions, landings and enqueues answer
// "already" on a repeat), so a call that did run before the reset is safe to repeat.
const RESET = /no longer active|Network connection lost|reset because its code was updated/i;

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
