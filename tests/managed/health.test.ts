// /health names the deployed revision: `cargo xtask deploy` compares it with HEAD.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ManagedEnv } from '../../cloudflare/managed/config';
import { managedFetch } from '../../cloudflare/managed/index';

describe('health', () => {
  it('reports the build revision', async () => {
    const managed = { ...(env as unknown as ManagedEnv), BUILD_REVISION: 'abc123' };
    const body = await (await managedFetch(new Request('https://managed.example.com/health'), managed)).json();
    expect(body).toEqual({ service: 'yonedarepo-agents-managed', v: 1, revision: 'abc123' });
  });
});
