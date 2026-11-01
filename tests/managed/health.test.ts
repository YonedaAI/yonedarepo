// /health names the deployed revision: `cargo xtask deploy` compares it with HEAD.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ManagedEnv } from '../../cloudflare/managed/config';
import worker, { managedFetch } from '../../cloudflare/managed/index';
import { Platform } from '../../cloudflare/managed/platform';
import { inScope } from '../../cloudflare/worker/request-scope';

describe('health', () => {
  it('reports the build revision', async () => {
    const managed = { ...(env as unknown as ManagedEnv), BUILD_REVISION: 'abc123' };
    const body = await (await managedFetch(new Request('https://managed.example.com/health'), managed)).json();
    expect(body).toEqual({ service: 'yonedarepo-agents-managed', v: 1, revision: 'abc123' });
  });
});

it('carries the request id: on the answer, and to the platform', async () => {
  const seen: (string | null)[] = [];
  const PLATFORM = {
    fetch: async (req: Request) => {
      seen.push(req.headers.get('x-request-id'));
      return Response.json({ repos: [] });
    },
  };
  const target = { ...env, REQUEST_IDS: 'on', PLATFORM } as unknown as ManagedEnv;
  const ask = new Request('https://managed.example.com/health', { headers: { 'cf-ray': '8f1c2d3e4a5b6c7d-SJC' } });
  const answer = await worker.fetch(ask, target, createExecutionContext());
  expect(answer.headers.get('x-request-id')).toBe('8f1c2d3e4a5b6c7d-SJC');
  await inScope({ env: target, req: ask }, () => new Platform(target, { token: 't' }).status('r0123456789abcdef0123'));
  expect(seen).toEqual(['8f1c2d3e4a5b6c7d-SJC']);
  expect((await worker.fetch(ask, { ...target, REQUEST_IDS: 'off' }, createExecutionContext())).headers.has('x-request-id')).toBe(false);
});
