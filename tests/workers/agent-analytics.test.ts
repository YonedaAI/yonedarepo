// Agents in the analytics (AGENT_REPORT), through the real authority (workerd): an agent's credential
// reads as an agent and nothing else does, two tokens are two credentials, a point names no token,
// and a request still writes one point, after its answer. Analytics Engine is simulated at the
// binding and the SQL API, so the SQL itself is proven only on dev.
import { beforeEach, expect, it, vi } from 'vitest';
import { forgetInternalAccounts, noteAccount, withRequestAccount } from '../../cloudflare/worker/internal-accounts';
import { agentView, agentsQuery, foldAgents, peakQuery, reachedQuery } from '../../cloudflare/worker/platform-agent-report';
import { adminReports } from '../../cloudflare/worker/platform-operations-report';
import { foldUsage } from '../../cloudflare/worker/platform-repo-insights';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { trafficSpan } from '../../cloudflare/worker/platform-traffic-queries';
import { caller, RepoContext } from '../../cloudflare/worker/repo-ops';
import { HeadHolder } from '../../cloudflare/worker/repo-head-holder';
import { issuePat, verifyPat } from '../../cloudflare/worker/repo-pat';
import { headAccess } from '../../cloudflare/worker/repo-snapshots';
import { requestUsage } from '../../cloudflare/worker/repo-usage';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
beforeEach(forgetInternalAccounts);

const NOW = Date.UTC(2026, 11, 20, 15, 30);

const on = (extra: Partial<Env> = {}) => {
  const points: AnalyticsEngineDataPoint[] = [];
  const env = {
    ...scoped,
    TRAFFIC_EVENTS: 'on',
    TRAFFIC_REPORT: 'on',
    REPO_ANALYTICS: 'on',
    AGENT_REPORT: 'on',
    SITE_EVENTS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) },
    CF_ACCOUNT_ID: 'f011d0ee02b23cad26b4b38151b204ad',
    SITE_EVENTS_DATASET: 'test_events',
    ANALYTICS_READ_TOKEN: 'test-read-token',
    ...extra,
  } as unknown as Env;
  return { env, points };
};

const SCOPES = ['repo:read', 'repo:write', 'repo:land'];

/** An account with a repository, and agent tokens as the device flow labels them. */
async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, {
    body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('src/a.rs', 'a\n')], author },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id as string;
  const agent = async (label: string) => {
    const issued = await issuePat(scoped, name, { name: label, scopes: SCOPES }, { origin: `agent:${label}`, host: null });
    return { token: issued.token, id: issued.id };
  };
  return { owner, id, repo: `/repos/${id}`, agent };
}

const read = (p: AnalyticsEngineDataPoint) => ({
  index: p.indexes?.[0],
  client: p.blobs?.[10],
  operation: p.blobs?.[11],
  outcome: p.blobs?.[12],
  repo: p.blobs?.[13],
  actor: p.blobs?.[14],
  detail: p.blobs?.[16],
  credential: p.blobs?.[17],
  named: p.blobs?.[18],
  weight: p.doubles?.[2],
});

it('reads an agent as an agent, and a person with a token as a person with a token', async () => {
  const s = await setup('kinds_owner');
  const agent = await s.agent('claude-code');
  const person = (await api('/tokens', s.owner, { body: { name: 'laptop', scopes: SCOPES } })).body.token as string;
  const { env, points } = on();
  const random = Math.random;
  Math.random = () => 0;
  await api(`${s.repo}/refs`, agent, {}, env);
  await api(`${s.repo}/refs`, { token: person }, {}, env);
  await api(`${s.repo}/refs`, s.owner, {}, env);
  Math.random = random;
  expect(points).toHaveLength(2);
  expect(read(points[0])).toMatchObject({ actor: 'agent', named: 'claude', outcome: 'success' });
  expect(read(points[1]).actor).not.toBe('agent');
  expect(read(points[1]).credential).toBeUndefined();
});

it('says two tokens are two credentials, and one token is always the same one', async () => {
  const s = await setup('two_owner');
  const first = await s.agent('codex');
  const second = await s.agent('opencode');
  const { env, points } = on();
  await api(`${s.repo}/refs`, first, {}, env);
  await api(`${s.repo}/commits/main`, first, {}, env);
  await api(`${s.repo}/refs`, second, {}, env);
  const [a, b, c] = points.map((p) => read(p).credential);
  expect(a).toMatch(/^[0-9a-f]{16}$/);
  expect(b).toBe(a);
  expect(c).toMatch(/^[0-9a-f]{16}$/);
  expect(c).not.toBe(a);
  expect(points.map((p) => read(p).named)).toEqual(['codex', 'codex', 'opencode']);
});

it('holds no token, token id, agent name or account on a point', async () => {
  const s = await setup('names_owner');
  const agent = await s.agent('private-name-of-a-bot');
  const { env, points } = on();
  await api(`${s.repo}/refs`, agent, {}, env);
  const text = JSON.stringify(points);
  expect(text).not.toContain(agent.token);
  expect(text).not.toContain(agent.id);
  expect(text).not.toContain('private-name');
  expect(text).not.toContain('names_owner');
  expect(read(points[0]).named).toBe('');
});

it('takes a client name only from a fixed list, from the token or the user agent', async () => {
  const s = await setup('agent_ua_owner');
  const agent = await s.agent('ci-runner');
  const { env, points } = on();
  await platformFetch(
    new Request(`https://yoneda/api/v1${s.repo}/refs`, {
      headers: { authorization: `Bearer ${agent.token}`, 'user-agent': 'Claude-Code/1.2 (made up; extra=private)' },
    }),
    env,
  );
  expect(read(points[0]).named).toBe('claude');
  expect(JSON.stringify(points)).not.toContain('private');
});

it('writes every read of an agent, so one that only reads is seen, and still only one point', async () => {
  const s = await setup('reads_owner');
  const agent = await s.agent('codex');
  const { env, points } = on();
  const random = Math.random;
  Math.random = () => 0.99;
  await api(`${s.repo}/refs`, agent, {}, env);
  Math.random = random;
  expect(points).toHaveLength(1);
  expect(read(points[0])).toMatchObject({ operation: 'read', weight: 1 });
});

it('marks a repository reached over REST and MCP, and one that refused the agent not at all', async () => {
  const s = await setup('reach_owner');
  const other = await setup('reach_other');
  const agent = await s.agent('codex');
  const { env, points } = on();
  expect((await api(`${s.repo}/refs`, agent, {}, env)).status).toBe(200);
  expect(read(points[0])).toMatchObject({ repo: s.id, index: s.id });
  points.length = 0;

  expect((await api(`${other.repo}/refs`, agent, {}, env)).status).toBe(404);
  expect(read(points[0]).repo).toBe('');
  expect(read(points[0]).actor).toBe('agent');
  points.length = 0;

  // A tool's refusal is a 200 at the transport: only an answer from the repository names it.
  const tool = (repo: string) =>
    api(`${repo}/mcp`, agent, { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_status', arguments: {} } } }, env);
  await tool(other.repo);
  expect(read(points[0])).toMatchObject({ client: 'mcp', repo: '' });
  points.length = 0;
  await tool(s.repo);
  expect(read(points[0])).toMatchObject({ client: 'mcp', repo: s.id });
});

it('marks a repository reached by a read from its published head, not by the platform’s own read', async () => {
  const s = await setup('head_owner');
  const issued = await s.agent('codex');
  const { env: base } = on();
  const holder = new HeadHolder(base);
  const LAND_COMBINERS = {
    idFromName: (name: string) => name,
    get: () => ({
      head: (repo: string, min: number, since?: number) => holder.head(repo, min, since),
      access: (repo: string) => holder.access(repo),
    }),
  };
  const env = { ...base, LAND_COMBINERS } as unknown as Env;
  const grant = await verifyPat(env, issued.token);
  await withRequestAccount(async () => {
    noteAccount({ _pat: grant });
    await caller(env, s.id, { _system: 'projection' })({ op: 'repo_refs' });
    expect(requestUsage(env)?.repo).toBeUndefined();
    const agent = caller(env, s.id, { _pat: grant as NonNullable<typeof grant> });
    expect(await headAccess(new RepoContext(env, s.id, agent))).not.toBe(null);
    expect(requestUsage(env)?.repo).toBe(s.id);
  });
});

it('counts a landing by an agent as the agent', async () => {
  const s = await setup('land_owner');
  const agent = await s.agent('claude-code');
  const main = (await api(`${s.repo}/refs`, s.owner)).body.refs['refs/heads/main'] as string;
  const made = await api(
    `${s.repo}/commits`,
    agent,
    { body: { parent: main, base_version: 1, message: 'work', author, changes: [file('src/b.rs', 'b\n')] } },
  );
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const { env, points } = on();
  const landed = await api(`${s.repo}/land`, agent, { body: { ref: 'main', commit: made.body.commit } }, env);
  expect(landed.body.landed).toBe(true);
  expect(points).toHaveLength(1);
  expect(read(points[0])).toMatchObject({ operation: 'land', detail: 'landed', actor: 'agent', named: 'claude' });
});

it('counts a clone over Git as the agent, when the last byte has gone', async () => {
  const s = await setup('git_owner');
  const agent = await s.agent('opencode');
  const main = (await api(`${s.repo}/refs`, s.owner)).body.refs['refs/heads/main'] as string;
  const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
  const { env, points } = on();
  const answer = await platformFetch(
    new Request(`https://yoneda/git/${s.id}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${agent.token}`)}`, 'user-agent': 'git/2.50.0' },
      body: `${pkt(`want ${main} side-band-64k\n`)}0000${pkt('done\n')}`,
    }),
    env,
  );
  expect(answer.status).toBe(200);
  await answer.arrayBuffer();
  await vi.waitFor(() => expect(points).toHaveLength(1));
  expect(read(points[0])).toMatchObject({ operation: 'clone', repo: s.id, detail: 'clone', actor: 'agent', named: 'opencode' });
  expect(read(points[0]).credential).toMatch(/^[0-9a-f]{16}$/);
});

it('leaves an internal account out', async () => {
  const s = await setup('ours_owner');
  const agent = await s.agent('codex');
  await bindings.INDEX.prepare('UPDATE platform_accounts SET internal=1 WHERE account=?').bind('ours_owner').run();
  const { env, points } = on();
  await api(`${s.repo}/refs`, agent, {}, env);
  expect(points).toEqual([]);
  await bindings.INDEX.prepare('UPDATE platform_accounts SET internal=0').run();
});

it('writes the same point as before with the switch off', async () => {
  const s = await setup('off_owner');
  const agent = await s.agent('claude-code');
  const main = (await api(`${s.repo}/refs`, s.owner)).body.refs['refs/heads/main'] as string;
  const made = await api(`${s.repo}/commits`, agent, { body: { parent: main, base_version: 1, message: 'work', author, changes: [file('src/b.rs', 'b\n')] } });
  const { env, points } = on({ AGENT_REPORT: undefined });
  await api(`${s.repo}/land`, agent, { body: { ref: 'main', commit: made.body.commit } }, env);
  expect(read(points[0])).toMatchObject({ actor: 'personal_token', detail: 'landed' });
  expect(points[0].blobs).toHaveLength(17);
  points.length = 0;
  const random = Math.random;
  Math.random = () => 0;
  await api(`${s.repo}/refs`, agent, {}, env);
  Math.random = random;
  expect(read(points[0])).toMatchObject({ weight: 10, repo: undefined, actor: undefined });
});

it('needs repository analytics, and says which tabs exist here', () => {
  expect(adminReports({} as Env).agents).toBe(false);
  expect(adminReports({ AGENT_REPORT: 'on' } as Env).agents).toBe(false);
  expect(adminReports(on().env).agents).toBe(true);
});

it('tells an agent from other tokens in a repository’s Insights', () => {
  const at = `${new Date(NOW).toISOString().slice(0, 13)}`;
  const row = (actor: string) => ({ bucket: at, actor, reason: '', detail: 'landed', count: 2, sampling: 1 });
  const usage = foldUsage([row('agent'), row('personal_token')], trafficSpan('7d', NOW));
  expect(usage.who.map((w) => w.key).sort()).toEqual(['agent', 'token']);
});

const slot = (minutes: number) => Math.floor(NOW / 1000 / 1800) * 1800 - minutes * 60;
const row = (extra: object) => ({
  credential: 'aaaa',
  slot: slot(0),
  client: 'claude',
  requests: 10,
  reads: 5,
  writes: 2,
  mcp: 1,
  landed: 2,
  refused: 1,
  failed: 0,
  already: 1,
  retries: 2,
  failures: 3,
  unauthorized: 1,
  rate_limited: 1,
  sampling: 1,
  ...extra,
});

it('asks only for agent points, weighted, with no account or name', () => {
  const span = trafficSpan('7d', NOW);
  const main = agentsQuery('events', span);
  expect(main).toContain("blob15 = 'agent'");
  expect(main).toContain("blob18 != ''");
  expect(main).toContain("blob1 = 'client'");
  expect(main).toContain('double5 = 1');
  expect(main).toContain('SUM(_sample_interval');
  expect(main).toContain("INTERVAL '30' MINUTE");
  expect(main).toContain('GROUP BY credential, slot, client');
  expect(main).toContain('LIMIT 20000');
  expect(reachedQuery('events', span)).toContain("blob14 != ''");
  const peak = peakQuery('events', span);
  expect(peak).toContain("INTERVAL '1' MINUTE");
  expect(peak).toContain('COUNT(DISTINCT blob18)');
  expect(peak).toContain('LIMIT 1');
});

it('folds credentials, half hours, rates and clients', () => {
  const span = trafficSpan('7d', NOW);
  const report = foldAgents(
    [
      row({}),
      row({ slot: slot(30) }),
      row({ credential: 'bbbb', client: 'codex', landed: 0, refused: 0, retries: 0, already: 0 }),
      row({ credential: 'cccc', client: '', requests: 1 }),
    ],
    [{ repo: 'r1', sampling: 1 }, { repo: 'r2', sampling: 1 }],
    [{ credentials: 3, sampling: 1 }],
    1,
    span,
  );
  expect(report).toMatchObject({
    range: '7d',
    credentials: 3,
    sessions: 4,
    repositories: 2,
    organizations: 1,
    concurrency: 3,
    reads: 20,
    writes: 8,
    mcp_calls: 4,
    landings: 6,
    landings_refused: 3,
    landings_failed: 0,
    failures: 12,
    unauthorized: 4,
    rate_limited: 4,
    estimated: false,
  });
  expect(report.success_rate).toBeCloseTo(6 / 9);
  // Rounds the platform repeated (6) and landings asked for again (3), over those asked for.
  expect(report.retry_rate).toBeCloseTo(9 / 9);
  expect(report.series).toHaveLength(span.buckets);
  expect(report.series.at(-1)?.credentials).toBe(3);
  expect(report.clients).toEqual([
    { client: 'claude', credentials: 1, requests: 20, landings: 4, estimated: false },
    { client: 'codex', credentials: 1, requests: 10, landings: 0, estimated: false },
    { client: '', credentials: 1, requests: 1, landings: 2, estimated: false },
  ]);
});

it('has no rate with nothing to rate, and marks an estimate', () => {
  const span = trafficSpan('24h', NOW);
  const none = foldAgents([], [], [], 0, span);
  expect(none).toMatchObject({ credentials: 0, success_rate: null, retry_rate: null, concurrency: 0, estimated: false });
  expect(foldAgents([row({ sampling: 3 })], [], [], 0, span).estimated).toBe(true);
  expect(foldAgents([row({})], [{ repo: 'r', sampling: 2 }], [], 0, span).estimated).toBe(true);
  expect(foldAgents([row({})], [], [{ credentials: 1, sampling: 4 }], 0, span).estimated).toBe(true);
  const full = Array.from({ length: 20_000 }, (_, n) => row({ credential: `c${n}` }));
  expect(foldAgents(full, [], [], 0, span).estimated).toBe(true);
});

/** The SQL API, answering each statement by what it asks for. */
function sqlApi(rows: object[], reached: object[], peak: object[]) {
  const asked: string[] = [];
  const fetcher = async (_url: unknown, init: RequestInit) => {
    const sql = String(init.body);
    asked.push(sql);
    return Response.json({ data: sql.includes('DISTINCT') ? peak : sql.includes('AS repo') ? reached : rows });
  };
  return { asked, fetcher: fetcher as unknown as typeof fetch };
}

it('answers off, not set up and failed apart, and spends what its budget says', async () => {
  const query = new URLSearchParams('range=7d');
  expect(await agentView({} as Env, query)).toEqual({ ok: false, reason: 'off' });
  const { env } = on();
  const unset = { ...env, ANALYTICS_READ_TOKEN: undefined } as Env;
  expect(await agentView(unset, query)).toEqual({ ok: false, reason: 'not_configured' });
  const down = async () => new Response('', { status: 500 });
  expect(await agentView(env, query, down as typeof fetch, NOW)).toEqual({ ok: false, reason: 'query_failed' });

  const { asked, fetcher } = sqlApi([row({})], [], [{ credentials: 1, sampling: 1 }]);
  const answer = await agentView(env, query, fetcher, NOW);
  expect(answer).toMatchObject({ ok: true, report: { credentials: 1, organizations: 0 } });
  expect(asked).toHaveLength(3);
});

it('counts organizations from the owners of the repositories reached', async () => {
  const person = await setup('org_person');
  await bindings.INDEX.prepare('INSERT INTO platform_repos(id,workspace,name,created_at) VALUES(?,?,?,1)').bind('r_org_a', 'acme', 'a').run();
  await bindings.INDEX.prepare('INSERT INTO platform_repos(id,workspace,name,created_at) VALUES(?,?,?,1)').bind('r_org_b', 'acme', 'b').run();
  const { env } = on();
  const { fetcher } = sqlApi(
    [row({})],
    [{ repo: person.id, sampling: 1 }, { repo: 'r_org_a', sampling: 1 }, { repo: 'r_org_b', sampling: 1 }],
    [{ credentials: 1, sampling: 1 }],
  );
  const answer = await agentView(env, new URLSearchParams('range=7d'), fetcher, NOW);
  expect(answer).toMatchObject({ ok: true, report: { repositories: 3, organizations: 1 } });
});
