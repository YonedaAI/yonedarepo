import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { fetchRequest } from '../../cloudflare/worker/routes';
import type { Env } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;

it('forwards the platform API unchanged to the platform Worker and never answers it itself', async () => {
  const platform = { fetch: vi.fn(async (req: Request) => Response.json({ forwarded: new URL(req.url).pathname, auth: req.headers.get('authorization') })) };
  const request = new Request('https://yoneda/api/v1/repos/r0123456789abcdef0123/log', { headers: { authorization: 'Bearer yrp_token' } });
  const response = await fetchRequest(request, { ...bindings, PLATFORM: platform } as unknown as Env);
  expect(await response.json()).toEqual({ forwarded: '/api/v1/repos/r0123456789abcdef0123/log', auth: 'Bearer yrp_token' });
  expect(platform.fetch).toHaveBeenCalledOnce();
  const unbound = await fetchRequest(request, { ...bindings, PLATFORM: undefined } as unknown as Env);
  expect(unbound.status).toBe(404);
});
