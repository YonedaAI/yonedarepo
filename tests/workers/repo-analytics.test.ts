// Repository analytics through the real authority (workerd): a landing refused by a gate leaves one
// point with its reason, after the answer; a clone's point has its bytes once the last byte went;
// a request the repository refused puts nothing on it; and only a reader of the whole repository
// gets its Insights, whatever figures are held. Analytics Engine is simulated at the binding and
// the SQL API, so the SQL itself is proven only on dev.
import { beforeEach, expect, it, vi } from 'vitest';
import { forgetInternalAccounts } from '../../cloudflare/worker/internal-accounts';
import { recordJob } from '../../cloudflare/worker/platform-client-events';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { forgetInsights } from '../../cloudflare/worker/platform-repo-insights';
import type { Env } from '../../cloudflare/worker/types';
import { compute } from '../../cloudflare/worker/repo-compute';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
beforeEach(() => {
  forgetInsights();
  forgetInternalAccounts();
});

const on = (extra: Partial<Env> = {}) => {
  const points: AnalyticsEngineDataPoint[] = [];
  const env = {
    ...scoped,
    TRAFFIC_EVENTS: 'on',
    TRAFFIC_REPORT: 'on',
    REPO_ANALYTICS: 'on',
    SITE_EVENTS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) },
    CF_ACCOUNT_ID: 'f011d0ee02b23cad26b4b38151b204ad',
    SITE_EVENTS_DATASET: 'test_events',
    ANALYTICS_READ_TOKEN: 'test-read-token',
    ...extra,
  } as unknown as Env;
  return { env, points };
};

async function setup(name: string, policy: object = { required_checks: [], approvals: 1 }) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, {
    body: { name, policy, files: [file('src/a.rs', 'a\n')], author },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id as string;
  const repo = `/repos/${id}`;
  const mint = async (label: string, scopes: string[], paths?: string[]) => ({
    token: (await api(`${repo}/tokens`, owner, { body: { name: label, scopes, paths } })).body
      .token as string,
  });
  const main = (await api(`${repo}/refs`, owner)).body.refs['refs/heads/main'] as string;
  return { owner, id, repo, main, mint };
}

async function work(s: Awaited<ReturnType<typeof setup>>, who: { token: string }, name: string) {
  const made = await api(`${s.repo}/commits`, who, {
    body: {
      parent: s.main,
      base_version: 1,
      message: 'work',
      author,
      changes: [file(`src/${name}.rs`, `${name}\n`)],
    },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return made.body.commit as string;
}

/** The fields of one point, by what they hold. */
const read = (p: AnalyticsEngineDataPoint) => ({
  index: p.indexes?.[0],
  event: p.blobs?.[0],
  client: p.blobs?.[10],
  operation: p.blobs?.[11],
  outcome: p.blobs?.[12],
  repo: p.blobs?.[13],
  actor: p.blobs?.[14],
  reason: p.blobs?.[15],
  detail: p.blobs?.[16],
  bytes: p.doubles?.[6],
});

it('records a gate refusal with its reason in the one point, and then the landing', async () => {
  const s = await setup('refusal_owner');
  const bot = await s.mint('bot', ['read', 'write', 'land']);
  const sha = await work(s, bot, 'x');
  const { env, points } = on();
  const refused = await api(`${s.repo}/land`, bot, { body: { ref: 'main', commit: sha } }, env);
  expect(refused.body.error.code).toBe('NOT_READY');
  expect(points).toHaveLength(1);
  expect(read(points[0])).toMatchObject({
    index: s.id,
    event: 'client',
    client: 'token',
    operation: 'land',
    outcome: 'failed',
    repo: s.id,
    actor: 'repo_token',
    reason: 'needs_approval',
    detail: 'refused',
  });

  expect((await api(`${s.repo}/commits/${sha}/reviews`, s.owner, { body: { decision: 'approve' } })).status).toBe(200);
  points.length = 0;
  const landed = await api(`${s.repo}/land`, bot, { body: { ref: 'main', commit: sha } }, env);
  expect(landed.body.landed).toBe(true);
  expect(points).toHaveLength(1);
  expect(read(points[0])).toMatchObject({ outcome: 'success', detail: 'landed', reason: '' });

  points.length = 0;
  await api(`${s.repo}/land`, bot, { body: { ref: 'main', commit: sha } }, env);
  expect(read(points[0])).toMatchObject({ detail: 'already' });
});

it('names which gate held a commit back', async () => {
  const s = await setup('gate_owner', {
    required_checks: ['unit'],
    approvals: 0,
    check_posters: { unit: ['token:ci'] },
  });
  const bot = await s.mint('bot', ['read', 'write', 'land']);
  const ci = await s.mint('ci', ['read', 'check']);
  const sha = await work(s, bot, 'x');
  const { env, points } = on();
  const land = () => api(`${s.repo}/land`, bot, { body: { ref: 'main', commit: sha } }, env);
  await land();
  await api(`${s.repo}/commits/${sha}/checks`, ci, { body: { name: 'unit', status: 'fail' } }, env);
  await land();
  expect(points.map((p) => read(p).reason)).toEqual(['checks_missing', '', 'checks_failed']);
  expect(read(points[1])).toMatchObject({ detail: 'check:fail', repo: s.id });
});

it('counts a landing from a browser under its own event, as a person', async () => {
  const s = await setup('browser_owner', { required_checks: [], approvals: 0 });
  const bot = await s.mint('bot', ['read', 'write']);
  const sha = await work(s, bot, 'x');
  const { env, points } = on();
  await api(`${s.repo}/refs`, s.owner, {}, env);
  expect(points).toEqual([]);
  const landed = await api(`${s.repo}/land`, s.owner, { body: { ref: 'main', commit: sha } }, env);
  expect(landed.body.landed).toBe(true);
  expect(points).toHaveLength(1);
  expect(read(points[0])).toMatchObject({
    event: 'repo',
    client: 'browser',
    operation: 'land',
    actor: 'person',
    detail: 'landed',
  });
});

it('puts nothing on a repository for a request it refused', async () => {
  const s = await setup('refused_owner');
  const reader = await s.mint('reader', ['read']);
  const bot = await s.mint('bot', ['read', 'write']);
  const sha = await work(s, bot, 'x');
  const { env, points } = on();
  const other = { cookie: await signup('refused_stranger') };
  expect((await api(`${s.repo}/land`, reader, { body: { ref: 'main', commit: sha } }, env)).status).toBe(403);
  expect((await api(`${s.repo}/land`, other, { body: { ref: 'main', commit: sha } }, env)).status).toBe(404);
  // The token is a client, so it keeps its client point. It names no repository.
  expect(points.map((p) => read(p).repo)).toEqual(['']);
  expect(read(points[0])).toMatchObject({ index: 'client', detail: '', reason: '' });
});

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const basic = (password: string) => `Basic ${btoa(`git:${password}`)}`;

it('writes a clone once, with its bytes, when the last byte has gone', async () => {
  const s = await setup('clone_owner');
  const reader = await s.mint('reader', ['read']);
  const { env, points } = on();
  const answer = await platformFetch(
    new Request(`https://yoneda/git/${s.id}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: basic(reader.token) },
      body: `${pkt(`want ${s.main} side-band-64k\n`)}0000${pkt('done\n')}`,
    }),
    env,
  );
  expect(answer.status).toBe(200);
  // The stream hasn't been read: its point waits for it.
  expect(points).toEqual([]);
  const sent = new Uint8Array(await answer.arrayBuffer());
  await vi.waitFor(() => expect(points).toHaveLength(1));
  const point = read(points[0]);
  expect(point).toMatchObject({ operation: 'clone', repo: s.id, detail: 'clone', actor: 'repo_token' });
  expect(point.bytes).toBeGreaterThan(0);
  expect(point.bytes).toBeLessThanOrEqual(sent.length);
});

type Raw = { id: string; kind: string; data: Uint8Array };
const text = new TextEncoder();
async function object(kind: string, data: Uint8Array): Promise<Raw> {
  const head = text.encode(`${kind} ${data.length}\0`);
  const whole = new Uint8Array([...head, ...data]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', whole));
  return { id: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''), kind, data };
}

/** A real receive-pack of one new commit on top of `parent`. */
async function pushBody(refname: string, parent: string, label: string) {
  const blob = await object('blob', text.encode(`${label}\n`));
  const hash = Uint8Array.from(blob.id.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
  const tree = await object('tree', new Uint8Array([...text.encode(`100644 ${label}.md\0`), ...hash]));
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object(
    'commit',
    text.encode(`tree ${tree.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${label}\n`),
  );
  const { push_b64 } = compute({
    op: 'branch_push',
    refname,
    old: null,
    new: commit.id,
    objects: [commit, tree, blob].map((o) => ({
      id: o.id,
      kind: o.kind,
      data_b64: btoa(String.fromCharCode(...o.data)),
    })),
  });
  return Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0));
}

it('counts a push apart from landings, with its bytes, and a push the gates refused', async () => {
  const s = await setup('push_owner');
  const writer = await s.mint('writer', ['read', 'write', 'land']);
  const { env, points } = on();
  const push = async (refname: string, label: string) => {
    const answer = await platformFetch(
      new Request(`https://yoneda/git/${s.id}.git/git-receive-pack`, {
        method: 'POST',
        headers: { authorization: basic(writer.token) },
        body: await pushBody(refname, s.main, label),
      }),
      env,
    );
    expect(answer.status).toBe(200);
    return answer.text();
  };
  await push('refs/heads/work', 'work');
  // Refused by the gates inside a 200, which only the report says.
  expect(await push('refs/heads/main', 'main')).toContain('NOT_READY');
  expect(points.map(read)).toMatchObject([
    { operation: 'push', repo: s.id, detail: 'branch', reason: '' },
    { operation: 'push', repo: s.id, detail: 'base', reason: 'needs_approval' },
  ]);
  expect(read(points[0]).bytes).toBeGreaterThan(0);
});

it('counts a landing made through MCP as a landing, in one point', async () => {
  const s = await setup('mcp_owner', { required_checks: [], approvals: 0 });
  const bot = await s.mint('bot', ['read', 'write', 'land']);
  const sha = await work(s, bot, 'x');
  const { env, points } = on();
  const answer = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${s.id}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${bot.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'git_land', arguments: { ref: 'main', commit: sha } },
      }),
    }),
    env,
  );
  expect(answer.status).toBe(200);
  await answer.text();
  expect(points).toHaveLength(1);
  expect(read(points[0])).toMatchObject({ client: 'mcp', operation: 'land', detail: 'landed' });
});

it('leaves one point for a job, and none for a repository of ours', async () => {
  const s = await setup('job_owner');
  const { env, points } = on();
  await recordJob(env, s.id, { operation: 'write', detail: 'check:fail', ms: 80 });
  expect(points).toHaveLength(1);
  expect(read(points[0])).toMatchObject({
    index: s.id,
    event: 'repo',
    client: 'platform',
    actor: 'platform',
    detail: 'check:fail',
  });
  expect(points[0].doubles?.[5]).toBe(80);
  await bindings.INDEX.prepare('UPDATE platform_accounts SET internal=1').run();
  forgetInternalAccounts();
  points.length = 0;
  await recordJob(env, s.id, { operation: 'write', detail: 'check:pass' });
  expect(points).toEqual([]);
  await recordJob(env, 'r00000000000000000000', { operation: 'write', detail: 'check:pass' });
  expect(points).toEqual([]);
  await expect(recordJob({ ...env, REPO_ANALYTICS: undefined }, s.id, { operation: 'write', detail: 'x' })).resolves.toBeUndefined();
});

it('counts no clone for a request that sent no pack', async () => {
  const s = await setup('lsrefs_owner');
  const reader = await s.mint('reader', ['read']);
  const { env, points } = on();
  const answer = await platformFetch(
    new Request(`https://yoneda/git/${s.id}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: basic(reader.token), 'git-protocol': 'version=2' },
      body: `${pkt('command=ls-refs\n')}0001${pkt('peel\n')}0000`,
    }),
    env,
  );
  expect(answer.status).toBe(200);
  await answer.arrayBuffer();
  expect(points).toHaveLength(1);
  expect(read(points[0])).toMatchObject({ operation: 'clone', detail: '' });
});

it('leaves the point as it was and the page unknown with the switch off', async () => {
  const s = await setup('off_owner');
  const bot = await s.mint('bot', ['read', 'write', 'land']);
  const sha = await work(s, bot, 'x');
  const { env, points } = on({ REPO_ANALYTICS: undefined });
  await api(`${s.repo}/land`, bot, { body: { ref: 'main', commit: sha } }, env);
  expect(points).toHaveLength(1);
  expect(points[0].blobs).toHaveLength(13);
  expect(points[0].doubles).toHaveLength(6);
  expect(points[0].indexes).toEqual(['client']);
  expect((await api(`${s.repo}/insights`, s.owner, {}, env)).status).toBe(404);
  expect((await api(s.repo, s.owner, {}, env)).body.insights).toBeUndefined();
});

/** The SQL API, answering one row per statement it's asked. */
function sqlApi(rows: object[] = []) {
  const asked: string[] = [];
  const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    asked.push(String(init?.body));
    return Response.json({ data: rows });
  });
  return { asked, stub };
}

it('serves Insights only to a reader of the whole repository', async () => {
  const s = await setup('insights_owner', { required_checks: [], approvals: 0 });
  const bot = await s.mint('bot', ['read', 'write']);
  const docs = await s.mint('docs', ['read'], ['docs/']);
  const sha = await work(s, bot, 'x');
  await api(`${s.repo}/land`, s.owner, { body: { ref: 'main', commit: sha } });
  const { env } = on();
  const now = new Date();
  const hour = `${now.toISOString().slice(0, 13)}`;
  const { asked } = sqlApi([
    { bucket: hour, actor: 'anonymous', reason: '', detail: 'clone', count: 4, sampling: 1 },
    { bucket: hour, actor: 'repo_token', reason: 'conflict', detail: 'refused', count: 2, sampling: 1 },
  ]);
  const insights = `${s.repo}/insights?range=7d`;
  const stranger = { cookie: await signup('insights_stranger') };

  // Before any figures are held: a stranger, a path-limited token and nobody at all get nothing.
  expect((await api(insights, stranger, {}, env)).status).toBe(404);
  expect((await api(insights, docs, {}, env)).status).toBe(403);
  expect((await api(insights, {}, {}, env)).status).toBe(404);
  expect(asked).toEqual([]);

  const shown = await api(insights, s.owner, {}, env);
  expect(shown.status, JSON.stringify(shown.body)).toBe(200);
  expect(shown.body.usage).toMatchObject({ clones: 4, failed_landings: 2 });
  expect(shown.body.contributors).toEqual([
    { principal: 'token:bot', commits: 1 },
    { principal: 'user:insights_owner', commits: 1 },
  ]);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(`index1 = '${s.id}'`);

  // With figures held in this isolate: the same refusals, and no second statement for the owner.
  expect((await api(insights, stranger, {}, env)).status).toBe(404);
  expect((await api(insights, docs, {}, env)).status).toBe(403);
  expect((await api(insights, {}, {}, env)).status).toBe(404);
  expect((await api(insights, s.owner, {}, env)).status).toBe(200);
  expect(asked).toHaveLength(1);

  // Public, a stranger reads it; private again, at once not.
  await api(`${s.repo}/visibility`, s.owner, { method: 'PUT', body: { visibility: 'public' } }, env);
  expect((await api(insights, stranger, {}, env)).status).toBe(200);
  await api(`${s.repo}/visibility`, s.owner, { method: 'PUT', body: { visibility: 'private' } }, env);
  expect((await api(insights, stranger, {}, env)).status).toBe(404);
});

it('still names contributors when the figures cannot be read', async () => {
  const s = await setup('sql_down_owner', { required_checks: [], approvals: 0 });
  const bot = await s.mint('bot', ['read', 'write']);
  await work(s, bot, 'x');
  const { env } = on();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }));
  const shown = await api(`${s.repo}/insights`, s.owner, {}, env);
  expect(shown.status).toBe(200);
  expect(shown.body.usage).toBe(null);
  expect(shown.body.contributors).toHaveLength(1);
});

it('says Insights exists in the status of a repository, with the switch on', async () => {
  const s = await setup('flag_owner');
  expect((await api(s.repo, s.owner, {}, on().env)).body.insights).toBe(true);
});
