// Shared eval Worker test helpers: an eval env whose platform is the real in-process
// platform API, a direct handler call with the bearer secret, and a FAKE Messages endpoint.
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { handle } from '../../cloudflare/eval/index';
import type { EvalEnv } from '../../cloudflare/eval/types';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { scoped } from '../workers/repo-fixture';

export const SECRET = 'e'.repeat(40);
export const MODEL_HOSTS = ['https://api.z.ai/', 'https://token-plan-sgp.xiaomimimo.com/', 'https://api.xiaomimimo.com/'];

export const evalEnv = (over: Partial<EvalEnv> = {}, platform: Env = scoped): EvalEnv => ({
  EVAL_TOKEN: SECRET,
  EVAL_SPEND_CAP_MICROUSD: '8000',
  ZAI_KEY: { get: async () => 'zai-test-key' },
  MIMO_KEY: { get: async () => 'tp-test-key' },
  PLATFORM: { fetch: (request) => platformFetch(request, platform) },
  SPEND: (env as unknown as EvalEnv).SPEND,
  ...over,
});
export const call = (path: string, body?: unknown, token: string | null = SECRET, target = evalEnv()) =>
  handle(
    new Request(`https://eval${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    target,
    { backoffMs: 0, pollMs: 0 },
  );

export type Seen = { url: string; headers: Record<string, string>; body: any };
/** Fake Messages endpoint: `reply` answers each request; platform traffic passes through. */
export function fakeModel(reply: (body: any, n: number) => Response) {
  const seen: Seen[] = [];
  const prior = vi.mocked(globalThis.fetch).getMockImplementation();
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!MODEL_HOSTS.some((h) => url.startsWith(h))) return prior ? prior(input, init) : new Response(null, { status: 599 });
    const body = JSON.parse(String(init?.body));
    seen.push({ url, headers: init?.headers as Record<string, string>, body });
    return reply(body, seen.length);
  });
  return seen;
}
export const message = (content: unknown[], usage = { input_tokens: 3000, output_tokens: 100 }) =>
  Response.json({ id: 'msg', type: 'message', role: 'assistant', content, stop_reason: 'tool_use', usage });
export const use = (name: string, input: unknown, id = name) => ({ type: 'tool_use', id: `${id}-${Math.random()}`, name, input });

