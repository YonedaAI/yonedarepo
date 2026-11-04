// Request reconstruction must retain trusted caller geography. Token/background
// clients have no human Request; they must not invent or inherit one.
import { describe, expect, it } from 'vitest';
import type { ManagedEnv } from '../../cloudflare/managed/config';
import { Platform } from '../../cloudflare/managed/platform';

function fixture() {
  const calls: Request[] = [];
  const env = { PLATFORM: { fetch: async (req: Request) => {
    calls.push(req);
    return Response.json({ repositories: [], workspace: 'fixture' });
  } } } as unknown as ManagedEnv;
  return { calls, env };
}

describe('managed public API caller geography', () => {
  it.each(['EU', 'AS', 'OC', 'SA', 'AF', 'NA'])('preserves the original %s caller across reconstructed reads', async continent => {
    const { env, calls } = fixture();
    const forward = new Request('https://example.test/api/managed/agents', { headers: { cookie: 'fixture=session' } });
    Object.defineProperty(forward, 'cf', { value: { continent, colo: 'SJO' } });
    const client = new Platform(env, { forward });
    await client.session();
    await client.repos();
    expect(calls.map(r => r.cf?.continent)).toEqual([continent, continent]);
    expect(calls.every(r => r.headers.get('cookie') === 'fixture=session')).toBe(true);
  });

  it('background token clients have no inherited caller location', async () => {
    const { env, calls } = fixture();
    await new Platform(env, { token: 'fixture-token' }).repos();
    expect(calls[0].cf?.continent).toBeUndefined();
    expect(calls[0].headers.get('authorization')).toBe('Bearer fixture-token');
  });
});
