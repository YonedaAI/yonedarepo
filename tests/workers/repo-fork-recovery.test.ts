import { expect, it } from 'vitest';
import { caller } from '../../cloudflare/worker/repo-ops';
import { inScope } from '../../cloudflare/worker/request-scope';
import type { Env } from '../../cloudflare/worker/types';
import { api, fakeCombiners, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

it('releases an organization name when fork initialization is refused', async () => {
  const owner = { cookie: await signup('fork_refused') };
  const org = 'fork_refused_org';
  expect((await api('/orgs', owner, { body: { name: org } })).status).toBe(200);
  const parent = (await api('/repos', owner, { body: { name: 'source' } })).body.id;
  const failed = await api(`/repos/${parent}/fork`, owner, {
    body: { owner: org, name: 'retryable', policy: { approvals: -1, required_checks: [] } },
  });
  expect(failed.status).toBe(400);
  const removed = await api(`/orgs/${org}?confirm=${org}`, owner, { method: 'DELETE' });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
});

it('takes back an automatically placed unpublished fork and its parent registration after a listing failure', async () => {
  const owner = { cookie: await signup('fork_unlisted') };
  const org = 'fork_unlisted_org';
  expect((await api('/orgs', owner, { body: { name: org } })).status).toBe(200);
  const parent = (await api('/repos', owner, { body: { name: 'source' } })).body.id;
  const real = scoped.INDEX;
  let failedId: unknown;
  const INDEX = {
    batch: (statements: D1PreparedStatement[]) => real.batch(statements),
    prepare(sql: string) {
      const statement = real.prepare(sql);
      if (!sql.includes('INSERT INTO platform_repos')) return statement;
      return {
        bind(...values: unknown[]) {
          failedId = values[0];
          return { run: async () => { throw new Error('simulated listing outage'); } };
        },
      };
    },
  };
  let placed=0;
  const LAND_COMBINERS={
    idFromName:fakeCombiners.idFromName,
    get:(name:string)=>({...fakeCombiners.get(name),where:async()=>{placed++;return 'TST';}}),
  };
  const failing = { ...scoped, INDEX, LAND_COMBINERS, AUTOMATIC_LOCALITY:'on' } as unknown as Env;
  const body = { owner: org, name: 'retryable' };
  const req=new Request(`https://yoneda/api/v1/repos/${parent}/fork`,{cf:{continent:'EU'}});
  const failed = await inScope({env:failing,req},()=>api(`/repos/${parent}/fork`, owner, { body }, failing));
  expect(placed).toBe(3);
  expect(failed.status).toBe(500);
  expect(failedId).toMatch(/^r[0-9a-f]{20}$/);
  expect((await caller(scoped, parent, { _system: 'fork' })({ op: 'repo_fork_list' })).forks).toEqual([]);
  expect((await api(`/repos/${failedId}`, owner)).status).toBe(404);
  const retry = await api(`/repos/${parent}/fork`, owner, { body });
  expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  expect((await api(`/repos/${retry.body.id}?confirm=retryable`, owner, { method: 'DELETE' })).status).toBe(200);
  expect((await api(`/orgs/${org}?confirm=${org}`, owner, { method: 'DELETE' })).status).toBe(200);
});
