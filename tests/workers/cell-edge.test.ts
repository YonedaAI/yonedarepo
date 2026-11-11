// The first hop is transport only: known IDs route directly and readable names reach
// the API, which resolves and authorizes them once.
import { beforeEach, describe, expect, it } from 'vitest';
import { cellOfRequest, edgeFetch, frontEnv, toCell } from '../../cloudflare/worker/cell-edge';
import { HOME_COOKIE } from '../../cloudflare/worker/cell-names';
import { newRepoId, tokenPrefix } from '../../cloudflare/worker/cells';
import type { Env } from '../../cloudflare/worker/types';

const reached: string[] = [];
const cell = (name: string) =>
  ({
    fetch: async () => {
      reached.push(name);
      return new Response(name);
    },
    accountCreated: async () => reached.push(`created:${name}`),
    verifyEmail: async () => reached.push(`verify:${name}`),
  }) as unknown as Fetcher;

/** Fails any read: nothing here may need one. */
const unreadable = new Proxy({}, { get: () => { throw new Error('read an authority'); } });
const base = { CELLS: 'on', PLATFORM: cell('enam'), CELL_WEUR: cell('weur') };
const env = { ...base, WORKSPACES: unreadable } as unknown as Env;
const weurRepo = newRepoId({ CELL: 'weur' } as Env);
const enamRepo = 'r0123456789abcdef0123';
const ask = (path: string, init: RequestInit = {}, on = env) =>
  cellOfRequest(new Request(`https://edge.test${path}`, init), on, new URL(path, 'https://edge.test'));

beforeEach(() => {
  reached.length = 0;
});

describe('with a repository in the path', () => {
  it('its id decides, with nothing read', async () => {
    expect(await ask(`/api/v1/repos/${weurRepo}`)).toBe('weur');
    expect(await ask(`/git/${weurRepo}.git/info/refs`)).toBe('weur');
    expect(await ask(`/api/v1/repos/${enamRepo}/commits`)).toBe('enam');
  });

  it('a repository token changes nothing: it has no account to read', async () => {
    const headers = { authorization: 'Bearer yrp_anything' };
    expect(await ask(`/api/v1/repos/${weurRepo}/tree`, { headers })).toBe('weur');
  });
});

describe('with no repository in the path', () => {
  it("a personal token's tag decides", async () => {
    const tagged = `ypat_${tokenPrefix('weur')}${'x'.repeat(40)}`;
    expect(await ask('/api/v1/repos', { headers: { authorization: `Bearer ${tagged}` } })).toBe('weur');
    expect(await ask('/api/v1/repos', { headers: { authorization: `Bearer ypat_${'x'.repeat(43)}` } })).toBe('enam');
  });

  it('the home cookie decides, and an unknown one means nothing', async () => {
    expect(await ask('/api/v1/repos', { headers: { cookie: `a=b; ${HOME_COOKIE}=weur` } })).toBe('weur');
    expect(await ask('/api/v1/repos', { headers: { cookie: `${HOME_COOKIE}=mars` } })).toBe('enam');
  });

  it('a sign-in with no cookie goes by continent, and nothing else does', async () => {
    const european = new Request('https://edge.test/api/auth/login', { method: 'POST' });
    Object.defineProperty(european, 'cf', { value: { continent: 'EU' } });
    expect(await cellOfRequest(european, env, new URL(european.url))).toBe('weur');
    const reader = new Request('https://edge.test/api/v1/explore');
    Object.defineProperty(reader, 'cf', { value: { continent: 'EU' } });
    expect(await cellOfRequest(reader, env, new URL(reader.url))).toBe('enam');
  });
});

describe('with a readable name', () => {
  it('leaves readable names to the API without reading an authority at the edge', async () => {
    expect(await ask('/edgeowner/project.git/info/refs')).toBe('enam');
    expect(await ask('/api/v1/resolve/edgeowner/project')).toBe('enam');
    expect(await ask('/nobodyhere/project.git/info/refs')).toBe('enam');
  });
});

describe('the Workers', () => {
  it('the edge passes a request to its cell', async () => {
    await edgeFetch(new Request(`https://edge.test/api/v1/repos/${weurRepo}`), env);
    expect(reached).toEqual(['weur']);
  });

  it('the front leaves PLATFORM alone with the switch off', () => {
    const off = { PLATFORM: cell('enam') } as unknown as Env;
    expect(frontEnv(off)).toBe(off);
  });

  it('the front routes through PLATFORM with it on, and a new account goes to its region', async () => {
    const front = frontEnv(env);
    await front.PLATFORM?.fetch(new Request(`https://edge.test/api/v1/repos/${weurRepo}`));
    await (front.PLATFORM as any).accountCreated('alice', { region: 'weur' });
    await (front.PLATFORM as any).accountCreated('bob', { region: 'sam' });
    await (front.PLATFORM as any).verifyEmail('bob');
    expect(reached).toEqual(['weur', 'created:weur', 'created:enam', 'verify:enam']);
  });

  it('with no platform bound it says so', async () => {
    const answer = await toCell(new Request('https://edge.test/api/v1/x'), { CELLS: 'on' } as Env);
    expect(answer.status).toBe(404);
  });
});

it('carries attribution through the regional account-created RPC without changing its target',async()=>{
  const seen:unknown[][]=[];
  const target={accountCreated:async(...args:unknown[])=>{seen.push(args);}} as unknown as Fetcher;
  const routed=frontEnv({...env,CELL_WEUR:target});
  const observation={requestId:'request-123',span:'parent-123',source:'web',traffic:'ordinary',origin:'POST /api/auth/signup',selected:true};
  await (routed.PLATFORM as any).accountCreated('alice',{region:'weur'},observation);
  expect(seen).toEqual([['alice',{region:'weur'},observation]]);
});

it('invokes routed RPC methods without looking up Function.bind on the remote capability', async () => {
  const called: unknown[] = [];
  const method = function(this: unknown, ...args: unknown[]) { called.push(this, args); return Promise.resolve(['operator']); };
  Object.defineProperty(method, 'bind', { get() { throw new Error('RPC property access would call internalAccounts.bind'); } });
  const target = { internalAccounts: method } as unknown as Fetcher;
  const front = frontEnv({ ...env, PLATFORM: target });
  expect(await (front.PLATFORM as any).internalAccounts()).toEqual(['operator']);
  expect(called).toEqual([target, []]);
});
