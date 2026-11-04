// Two cells, end to end through the real routes, authorities and D1: `enam` and `weur`, each a
// Worker's env with its own D1 and bucket, sharing the account authorities and reaching each
// other as service bindings do. What matters here: a request sent to the wrong cell gets the
// right answer, a cell's rows stay in its own D1, and an account in one cell is untouched.
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { HOME_COOKIE } from '../../cloudflare/worker/cell-names';
import { cellOfRepo } from '../../cloudflare/worker/cells';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { closeAccount, closeCell, unlist } from '../../cloudflare/worker/platform-account-close';
import { closurePart } from '../../cloudflare/worker/platform-account-close-part';
import { mergeOverview, mergePages } from '../../cloudflare/worker/platform-admin-cells';
import { PAGE } from '../../cloudflare/worker/platform-admin-queries';
import { inScope } from '../../cloudflare/worker/request-scope';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, fakeCombiners, file, queued, scoped, usePlatformFixture } from './repo-fixture';
import { applySchema } from './repo-fixture-schema';

usePlatformFixture();

const served = (target: () => Env) =>
  ({
    fetch: (req: Request) => inScope({ env: target(), req }, () => platformFetch(req, target())),
    accountCreated: async () => {},
    closurePart: (account: string) => closurePart(target(), account),
    closeCell: (account: string) => closeCell(target(), account),
    unlistCell: (account: string) => unlist(target(), account),
  }) as unknown as Fetcher;

const weurIndex = (bindings as unknown as { INDEX_WEUR: D1Database }).INDEX_WEUR;
const weurBucket = (bindings as unknown as { OBJECTS_WEUR: R2Bucket }).OBJECTS_WEUR;
const shared = { CELLS: 'on', REGION_SIGNALS: 'on' };
const enam: Env = { ...scoped, ...shared, CELL_WEUR: served(() => weur), INDEX_WEUR: weurIndex, SELF: served(() => enam) };
const weur: Env = {
  ...scoped,
  ...shared,
  CELL: 'weur',
  INDEX: weurIndex,
  OBJECTS: weurBucket,
  CELL_ENAM: served(() => enam),
  INDEX_ENAM: scoped.INDEX,
  SELF: served(() => weur),
};

const signupIn = async (target: Env, name: string, continent: string) => {
  await applySchema(weurIndex);
  const req = new Request('https://yoneda/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.com`, password: 'long platform test password' }),
  });
  Object.defineProperty(req, 'cf', { value: { continent } });
  const answer = await platformFetch(req, target);
  expect(answer.status).toBe(200);
  const cookies = answer.headers.getSetCookie().map((c) => c.split(';')[0]);
  return { cookie: cookies.join('; '), cookies };
};

const repo = (name: string, extra = {}) => ({
  name,
  policy: { approvals: 0, required_checks: [] },
  files: [file('a.md', 'a\n')],
  author,
  ...extra,
});
const rowOf = (index: D1Database, id: string) =>
  index.prepare('SELECT id FROM platform_repos WHERE id=?').bind(id).first();

describe('a person who signs up in Europe', () => {
  it('gets a home in weur, and the browser is told', async () => {
    const { cookies } = await signupIn(weur, 'elsa', 'EU');
    expect(cookies).toContain(`${HOME_COOKIE}=weur`);
  });

  it("gets repositories there, from whichever Worker the request reached, in that cell's D1", async () => {
    const auth = await signupIn(weur, 'anna', 'EU');
    const created = await api('/repos', auth, { body: repo('project') }, enam);
    expect(created.status).toBe(200);
    expect(created.body.region).toBe('weur');
    expect(cellOfRepo(created.body.id)).toBe('weur');
    expect(await rowOf(weurIndex, created.body.id)).not.toBeNull();
    expect(await rowOf(scoped.INDEX, created.body.id)).toBeNull();
  });

  it('reads them through the wrong Worker, and the region is shown', async () => {
    const auth = await signupIn(weur, 'olaf', 'EU');
    const created = await api('/repos', auth, { body: repo('project') }, weur);
    const read = await api(`/repos/${created.body.id}`, auth, {}, enam);
    expect(read.status).toBe(200);
    expect(read.body.region).toBe('weur');
    const listed = await api('/repos', auth, {}, enam);
    expect(listed.body.repos.map((r: any) => [r.id, r.region])).toEqual([[created.body.id, 'weur']]);
  });

  it('may choose another region, and one listing shows both', async () => {
    const auth = await signupIn(weur, 'kris', 'EU');
    const here = await api('/repos', auth, { body: repo('near') }, weur);
    const there = await api('/repos', auth, { body: repo('far', { region: 'enam' }) }, weur);
    expect(there.status).toBe(200);
    expect(there.body.region).toBe('enam');
    expect(cellOfRepo(there.body.id)).toBe('enam');
    expect(await rowOf(scoped.INDEX, there.body.id)).not.toBeNull();
    const listed = await api('/repos', auth, {}, weur);
    expect(listed.body.repos.map((r: any) => r.id).sort()).toEqual([here.body.id, there.body.id].sort());
    expect(listed.body.partial).toBeUndefined();
  });

  it('holds a name across cells', async () => {
    const auth = await signupIn(weur, 'sven', 'EU');
    await api('/repos', auth, { body: repo('taken') }, weur);
    const again = await api('/repos', auth, { body: repo('taken', { region: 'enam' }) }, weur);
    expect(again.status).toBe(409);
  });

  it('forks stay in the parent’s cell, and asking otherwise says why', async () => {
    const auth = await signupIn(weur, 'gerda', 'EU');
    const parent = await api('/repos', auth, { body: repo('parent') }, weur);
    const fork = await api(`/repos/${parent.body.id}/fork`, auth, { body: { name: 'child' } }, enam);
    expect(fork.status).toBe(200);
    expect(cellOfRepo(fork.body.id)).toBe('weur');
    const refused = await api(`/repos/${parent.body.id}/fork`, auth, { body: { name: 'c2', region: 'enam' } }, enam);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/parent/);
  });

  it('reaches a repository by its readable name from either Worker', async () => {
    const auth = await signupIn(weur, 'hans', 'EU');
    const created = await api('/repos', auth, { body: repo('named') }, weur);
    const resolved = await api('/resolve/hans/named', auth, {}, enam);
    expect(resolved.status).toBe(200);
    expect(resolved.body.id).toBe(created.body.id);
  });

  it('gets tokens from its cell, usable on every cell', async () => {
    const auth = await signupIn(weur, 'freya', 'EU');
    const issued = await api('/tokens', auth, { body: { name: 't', scopes: ['repo:read', 'repo:admin'] } }, enam);
    expect(issued.status).toBe(200);
    expect(issued.body.token).toMatch(/^ypat_eu_[A-Za-z0-9_-]{40}$/);
    const hash = await weurIndex.prepare('SELECT COUNT(*) AS n FROM platform_tokens WHERE workspace=?').bind('freya').first<{ n: number }>();
    expect(hash?.n).toBe(1);
    const created = await api('/repos', { token: issued.body.token }, { body: repo('by-token') }, enam);
    expect(created.status).toBe(200);
    expect(created.body.region).toBe('weur');
    const elsewhere = await api('/repos', auth, { body: repo('us', { region: 'enam' }) }, weur);
    const read = await api(`/repos/${elsewhere.body.id}`, { token: issued.body.token }, {}, enam);
    expect(read.status).toBe(200);
  });
});

it.each([['EU', undefined], ['NA', 'weur'], ['AS', 'weur'], ['OC', 'weur']])('keeps selected authority placement consistent for visitor %s and selected region %s', async (continent, region) => {
  const auth = await signupIn(enam, 'travelingcreator', 'NA');
  // In-process combiners need the placement method; physical location is a live proof.
  const placed = { idFromName: fakeCombiners.idFromName, get: (name: string) => ({ ...fakeCombiners.get(name), where: async () => 'TST' }) } as unknown as DurableObjectNamespace;
  const automaticEnam: Env = { ...enam, LAND_COMBINERS: placed, AUTOMATIC_LOCALITY: 'on', CELL_WEUR: served(() => automaticWeur) };
  const automaticWeur: Env = { ...weur, LAND_COMBINERS: placed, AUTOMATIC_LOCALITY: 'on', CELL_ENAM: served(() => automaticEnam) };
  const req = new Request('https://yoneda/api/v1/repos', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: auth.cookie },
    body: JSON.stringify(repo('traveling-project', region ? { region } : {})), cf: { continent, colo: continent === 'EU' ? 'FRA' : 'IAD' },
  });
  const response = await platformFetch(req, automaticEnam);
  expect(response.status).toBe(200);
  const created = await response.json<any>();
  expect(cellOfRepo(created.id)).toBe('weur');
  expect(created.region_hint).toBe('weur');
  expect(await rowOf(weurIndex, created.id)).not.toBeNull();
  expect(await rowOf(scoped.INDEX, created.id)).toBeNull();
  const throughOriginal = await api(`/repos/${created.id}`, auth, {}, automaticEnam);
  expect(throughOriginal.status).toBe(200);
  expect(throughOriginal.body.region).toBe('weur');
  const listed = await api('/repos', auth, {}, automaticEnam);
  expect(listed.body.repos.map((r: any) => r.id)).toContain(created.id);
});

describe('a region that is not a cell', () => {
  it('is refused, not moved', async () => {
    const auth = await signupIn(weur, 'bjorn', 'EU');
    const refused = await api('/repos', auth, { body: repo('x', { region: 'mars' }) }, weur);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/enam, weur/);
  });
});

describe('an account from before cells', () => {
  it('stays in enam, reads one D1 and asks no other cell', async () => {
    const auth = await signupIn(enam, 'ursula', 'NA');
    const seen: string[] = [];
    const watched: Env = {
      ...enam,
      CELL_WEUR: { fetch: async (r: Request) => (seen.push(r.url), new Response('{}')) } as unknown as Fetcher,
    };
    const created = await api('/repos', auth, { body: repo('old') }, watched);
    expect(cellOfRepo(created.body.id)).toBe('enam');
    const listed = await api('/repos', auth, {}, watched);
    expect(listed.body.repos).toHaveLength(1);
    expect(seen).toEqual([]);
  });
});

describe('public reads', () => {
  it('explore shows both cells, and a cell that fails costs only its part', async () => {
    const eu = await signupIn(weur, 'ingrid', 'EU');
    const us = await signupIn(enam, 'walter', 'NA');
    await api('/repos', eu, { body: repo('open-eu', { visibility: 'public' }) }, weur);
    await api('/repos', us, { body: repo('open-us', { visibility: 'public' }) }, enam);
    const listed = await api('/explore?limit=7', {}, {}, enam);
    expect(listed.body.repos.map((r: any) => r.name).sort()).toEqual(['open-eu', 'open-us']);
    const broken: Env = {
      ...enam,
      CELL_WEUR: { fetch: async () => { throw new Error('down'); } } as unknown as Fetcher,
    };
    const partial = await api('/explore?limit=8', {}, {}, broken);
    expect(partial.body.repos.map((r: any) => r.name)).toEqual(['open-us']);
    expect(partial.body.partial).toBe(true);
  });

  it('a profile lists an owner’s repositories from its own cell', async () => {
    const eu = await signupIn(weur, 'astrid', 'EU');
    await api('/repos', eu, { body: repo('shown', { visibility: 'public' }) }, weur);
    const seen = await api('/profiles/astrid', {}, {}, enam);
    expect(seen.body.repositories.map((r: any) => r.name)).toEqual(['shown']);
  });
});

describe('with the switch off', () => {
  it('a region is ignored and ids carry no tag, as today', async () => {
    const auth = await signupIn(scoped, 'plain', 'EU');
    expect(auth.cookies.some((c) => c.startsWith(HOME_COOKIE))).toBe(false);
    const created = await api('/repos', auth, { body: repo('plain', { region: 'weur' }) });
    expect(created.status).toBe(200);
    expect(created.body.region).toBeUndefined();
    expect(cellOfRepo(created.body.id)).toBe('enam');
  });
});

describe('a token from the device flow', () => {
  const compact = (code: string) => code.replace('-', '');

  async function login(cookie: string) {
    const code = await api('/device/code', {}, { body: { client_name: 'yoneda-cli', host: 'box' } }, enam);
    const scopes = ['repo:read', 'repo:admin'];
    const approved = await api('/device/approve', { cookie }, { body: { user_code: code.body.user_code, scopes } }, enam);
    expect(approved.status).toBe(200);
    const device = bindings.WORKSPACES.idFromName(`device:${compact(code.body.user_code)}`);
    await runInDurableObject(bindings.WORKSPACES.get(device), (_i, state) => {
      state.storage.sql.exec('UPDATE device_codes SET last_poll_at=NULL');
    });
    const poll = await api('/device/token', {}, { body: { device_code: code.body.device_code } }, enam);
    return poll.body.token as string;
  }

  it("belongs to its account's home, which the poll learns for itself", async () => {
    const eu = await signupIn(weur, 'mette', 'EU');
    expect(await login(eu.cookie)).toMatch(/^ypat_eu_/);
    const us = await signupIn(enam, 'dana', 'NA');
    expect(await login(us.cookie)).not.toMatch(/^ypat_eu_/);
  });
});

describe('an agent on the account-wide MCP', () => {
  const tool = (auth: { cookie: string }, target: Env, name: string, args: object) =>
    platformFetch(
      new Request('https://yoneda/api/v1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: auth.cookie },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      target,
    ).then((r) => r.json<any>());

  it('reaches a repository of another cell, by id and by name, and is told what refuses', async () => {
    const auth = await signupIn(weur, 'greta', 'EU');
    await api('/repos', auth, { body: repo('near') }, weur);
    const far = await api('/repos', auth, { body: repo('far', { region: 'enam' }) }, weur);
    const byName = await tool(auth, weur, 'git_status', { repo: 'far' });
    expect(byName.result.isError).toBeUndefined();
    expect(byName.result.structuredContent.name).toBe('far');
    const byId = await tool(auth, weur, 'git_status', { repo: far.body.id });
    expect(byId.result.structuredContent.name).toBe('far');
    const refused = await tool(auth, weur, 'git_show', { repo: far.body.id, commit: '0'.repeat(40) });
    expect(refused.result.isError).toBe(true);
  });
});

describe('closing an account', () => {
  it('takes its repositories, tokens and listing from every cell', async () => {
    const auth = await signupIn(weur, 'sigrid', 'EU');
    const near = await api('/repos', auth, { body: repo('near') }, weur);
    const far = await api('/repos', auth, { body: repo('far', { region: 'enam' }) }, weur);
    const done = await inScope({ env: weur }, () => closeAccount(weur, 'self', 'sigrid'));
    expect(done).toMatchObject({ closed: true, repos: 2 });
    expect(await rowOf(weurIndex, near.body.id)).toBeNull();
    expect(await rowOf(scoped.INDEX, far.body.id)).toBeNull();
  });
});

describe('an org', () => {
  it("starts in its creator's region, and its repositories follow", async () => {
    const auth = await signupIn(weur, 'erika', 'EU');
    const org = await api('/orgs', auth, { body: { name: 'nordics' } }, enam);
    expect(org.status).toBe(200);
    const created = await api('/repos', auth, { body: repo('team', { owner: 'nordics' }) }, enam);
    expect(created.status).toBe(200);
    expect(created.body.region).toBe('weur');
    const listed = await api('/orgs/nordics/repos', auth, {}, weur);
    expect(listed.body.repos.map((r: any) => r.name)).toEqual(['team']);
  });
});

describe("the operators' lists", () => {
  const rows = (...ats: number[]) => ats.map((created_at) => ({ created_at }));

  it('merge newest first, and page from where the merge stopped', () => {
    const many = Array.from({ length: PAGE }, (_, i) => 1000 - i);
    const merged = mergePages([
      { items: rows(...many), next: 1 },
      { items: rows(2000), next: null },
    ] as any[]);
    expect((merged.items as any[])[0].created_at).toBe(2000);
    expect(merged.items).toHaveLength(PAGE);
    expect(merged.next).toBe((merged.items as any[]).at(-1).created_at);
  });

  it('add up', () => {
    const part = (total: number) => ({
      accounts: { total },
      repos: { public: total, private: 0 },
      suspended: 1,
      signups_per_day: [{ day: '2026-11-01', count: total }],
    });
    expect(mergeOverview([part(1), part(2)])).toMatchObject({
      accounts: { total: 3 },
      repos: { public: 3 },
      suspended: 2,
      signups_per_day: [{ day: '2026-11-01', count: 3 }],
    });
  });
});

it('background work of a cell stays on its queue', async () => {
  const auth = await signupIn(weur, 'nils', 'EU');
  const sent: any[] = [];
  const own = { send: async (m: any) => sent.push(m), sendBatch: async (ms: any[]) => sent.push(...ms) };
  const cell: Env = { ...weur, PLATFORM_QUEUE: own as unknown as Env['PLATFORM_QUEUE'] };
  const before = queued.length;
  const created = await api('/repos', auth, { body: repo('jobs') }, cell);
  expect(created.status).toBe(200);
  expect(sent.length).toBeGreaterThan(0);
  expect(queued.length).toBe(before);
});

it('forwards named Overview query parameters to the repository cell', async () => {
  const enamOverview: Env = { ...enam, OVERVIEW_BOOTSTRAP: 'on', CELL_WEUR: served(() => weurOverview) };
  const weurOverview: Env = { ...weur, OVERVIEW_BOOTSTRAP: 'on', CELL_ENAM: served(() => enamOverview) };
  const auth = await signupIn(enamOverview, 'overview_region', 'NA');
  const made = await api('/repos', auth, { body: repo('cross', { region: 'weur', files: [file('README.md', '# Across cells\n')] }) }, enamOverview);
  expect(made.status).toBe(200);
  const named = await api('/resolve/overview_region/cross?summary=true&overview=true&ref=main', auth, {}, enamOverview);
  expect(named.status, JSON.stringify(named.body)).toBe(200);
  expect(named.body).toMatchObject({ id: made.body.id, summary: { region: 'weur', overview: { ref: 'main', tree: { commit: made.body.commit }, readme: { content: '# Across cells\n' } } } });
});
