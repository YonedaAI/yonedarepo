import { expect, it } from 'vitest';
import { credentials } from '../../cloudflare/worker/repo-credentials';
import type { Env } from '../../cloudflare/worker/types';

it('a stalled earlier authentication cannot hold a later request with the same cookie', async () => {
  let finish!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => { finish = resolve; });
  const env = (fetch: () => Promise<Response>) => ({ WORKSPACES: {
    idFromName: () => ({}), get: () => ({ fetch }),
  } }) as unknown as Env;
  const request = () => new Request('https://yoneda/api/v1/repos', { headers: {
    cookie: `yoneda_account=isolation.${'a'.repeat(64)}`,
  } });
  const old = credentials(request(), env(() => held));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const current = credentials(request(), env(async () => Response.json({ authenticated: false })));
    const result = await Promise.race([current, new Promise<string>((resolve) => { timer = setTimeout(() => resolve('blocked by another request'), 500); })]);
    expect(result).toBeNull();
  } finally {
    clearTimeout(timer);
    finish(Response.json({ authenticated: false }));
    await old;
  }
});

it('does not share an unfinished organization lookup between requests', async () => {
  const { orgAccess, forgetOrgAccess } = await import('../../cloudflare/worker/platform-org-access');
  let finish!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => { finish = resolve; });
  const env = (fetch: () => Promise<Response>) => ({ WORKSPACES: {
    idFromName: () => ({}), get: () => ({ fetch }),
  } }) as unknown as Env;
  const old = orgAccess(env(() => held), 'isolation_member', ['isolation_org']);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const current = orgAccess(env(async () => Response.json({ role: 'owner', teams: [] })), 'isolation_member', ['isolation_org']);
    const result = await Promise.race([current, new Promise<string>((resolve) => { timer = setTimeout(() => resolve('blocked by another request'), 500); })]);
    expect(result).toMatchObject({ isolation_org: { role: 'owner', teams: [] } });
  } finally {
    clearTimeout(timer);
    finish(Response.json({ role: 'member', teams: [] }));
    await old;
    forgetOrgAccess('isolation_org');
  }
});

it('does not restore cached organization access when an invalidated lookup finishes late', async () => {
  const { orgAccess, forgetOrgAccess } = await import('../../cloudflare/worker/platform-org-access');
  let finish!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => { finish = resolve; });
  const env = (fetch: () => Promise<Response>) => ({ WORKSPACES: {
    idFromName: () => ({}), get: () => ({ fetch }),
  } }) as unknown as Env;
  const old = orgAccess(env(() => held), 'revoked_member', ['revoked_org']);
  forgetOrgAccess('revoked_org');
  finish(Response.json({ role: 'owner', teams: [] }));
  await old;
  const current = await orgAccess(env(async () => Response.json({ role: null })), 'revoked_member', ['revoked_org']);
  expect(current).toBeUndefined();
  forgetOrgAccess('revoked_org');
});
