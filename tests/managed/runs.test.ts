import { env, introspectWorkflowInstance, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chargeMicrousd,
  type ManagedAgentId,
  managedAgent,
  modelRate,
  usageCostMicrousd,
} from '../../shared/managed-agents';
import { resolveSettings, validateOverrides } from '../../shared/managed-settings';
import type { ManagedEnv, QueueMessage, RunParams } from '../../cloudflare/managed/config';
import { promptDiff } from '../../cloudflare/managed/diff-prompt';
import { consume } from '../../cloudflare/managed/dispatch';
import { outbound } from '../../cloudflare/managed/harness';
import { managedFetch } from '../../cloudflare/managed/index';
import { ledgerStub, STARTING_CREDIT_MICROUSD } from '../../cloudflare/managed/ledger';
import { repoStub } from '../../cloudflare/managed/repo-agents';
import { runAgent } from '../../cloudflare/managed/run';
import { LEDGER_SCHEMA, migrate, REPO_SCHEMA, WORKSPACE_SCHEMA } from '../../cloudflare/managed/schema';
import { workspaceStub } from '../../cloudflare/managed/workspace-agents';
import {
  BASE,
  fakeGateway,
  HEAD_A,
  HEAD_B,
  HOOK_SECRET,
  type Harness,
  harness,
  inline,
  KEYS,
  newRepo,
  signature,
} from './fake';
import { FIXTURES } from './fixtures';

afterEach(() => vi.restoreAllMocks());

const site = (h: Harness, path: string, init: RequestInit & { cookie?: string } = {}) =>
  managedFetch(
    new Request(`https://site.example.com/api/managed/workspaces/${h.platform.account}${path}`, {
      ...init,
      headers: { cookie: init.cookie ?? 'session=owner', 'content-type': 'application/json' },
    }),
    h.env,
  );
const put = (h: Harness, agent: string, body: unknown, cookie?: string) =>
  site(h, `/agents/${agent}`, { method: 'PUT', body: JSON.stringify(body), cookie });

async function deliver(h: Harness, ...bodies: QueueMessage[]) {
  const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
  await consume({ messages } as unknown as MessageBatch<QueueMessage>, h.env);
  for (const m of messages) expect(m.retry).not.toHaveBeenCalled();
}
const opened = (h: Harness, commit = HEAD_A): QueueMessage => ({
  kind: 'event',
  repo: h.platform.repo,
  event: 'change',
  ref: 'refs/heads/feature',
  commit,
  change: 1,
  action: 'opened',
});
const pushed = (h: Harness, commit: string): QueueMessage => ({
  kind: 'event',
  repo: h.platform.repo,
  event: 'branch',
  ref: 'refs/heads/feature',
  commit,
  change: null,
  action: 'moved',
});

/** One repository with one open change (the agent's trigger fixture), the agent enabled on it. */
async function ready(agent: ManagedAgentId = 'code-review', fixture: 'trigger' | 'clean' = 'trigger') {
  const h = harness();
  h.platform.change({ files: FIXTURES[agent][fixture].files });
  const res = await put(h, agent, { repos: [h.platform.repo] });
  expect(res.status).toBe(200);
  return h;
}
const run = (h: Harness, params: RunParams) => runAgent(h.env, params, inline);
/** Steps whose first sleep waits for `release`: the run is mid-flight with its container up. */
function gated() {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { steps: { do: inline.do, sleep: () => gate }, release };
}
const result = (agent: ManagedAgentId, fixture: 'trigger' | 'clean' = 'trigger') => ({
  summary: 'Reviewed.',
  findings: FIXTURES[agent][fixture].expected,
});

describe('the shared pipeline', () => {
  it('runs the agent in a harness container and posts anchored comments, a summary and the check', async () => {
    const h = await ready('code-review');
    const calls = fakeGateway();
    h.harness.scripts = [{ result: result('code-review'), polls: 2, calls: [{}, { stream: true }] }];
    await deliver(h, opened(h));
    expect(h.created).toHaveLength(1);
    const params = h.created[0];
    expect(await run(h, params)).toEqual({ status: 'findings', value: 'fail', findings: 1, withheld: 0 });

    // The container got the review, the configured harness and model, and no credential.
    const [{ spec, params: bound }] = h.harness.started;
    expect(spec).toMatchObject({
      harness: 'codex',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      reasoning: 'medium',
      timeout_ms: 20 * 60_000,
      base: BASE,
      head: HEAD_A,
      branch: 'feature',
      platform_origin: 'http://platform.internal',
      gateway: { base: 'http://gateway.internal/v1/acct/yonedarepo-test-agents' },
    });
    expect(spec.instructions).toContain('reviewing one change request for correctness');
    // The whole diff rides in the prompt context: the agent sees every changed line.
    expect(spec.context.diff).toContain('--- src/batch.js (modify)');
    expect(spec.context.diff).toContain('i <= items.length');
    expect(spec.context.diff).toContain('logo.png (binary)');
    expect(spec.contract).toContain('"findings"');
    const specText = JSON.stringify(spec);
    for (const key of [...Object.values(KEYS), 'yrp_fixture']) expect(specText).not.toContain(key);
    expect(bound).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna', cap_microusd: 1_000_000 });
    expect(h.harness.ended.size).toBe(1);

    expect(h.platform.comments.filter((c) => c.path).map((c) => [c.path, c.line, c.side, c.commit])).toEqual([
      ['src/batch.js', 3, 'new', HEAD_A],
    ]);
    expect(h.platform.comments.find((c) => !c.path).body).toContain('fail');
    expect(h.platform.checks).toEqual([
      expect.objectContaining({ commit: HEAD_A, name: 'code-review', status: 'fail', evidence: expect.objectContaining({ value: 'fail' }) }),
    ]);

    // Both model calls went through the gateway with the real key and run metadata.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`https://gateway.example.com/v1/acct/yonedarepo-test-agents/openai/responses`);
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEYS.codex}`);
    expect(JSON.parse(calls[0].headers['cf-aig-metadata'])).toEqual({
      account: h.platform.account,
      repo: h.platform.repo,
      change: 1,
      agent: 'code-review',
      run: params.run,
    });
    const rate = modelRate('codex', 'gpt-5.6-luna')!;
    const perCall = chargeMicrousd(usageCostMicrousd(rate, { input: 1000, cache_write: 0, cache_read: 0, output: 200 }));
    const stored = await repoStub(h.env, h.platform.repo).run(params.run);
    expect(stored).toMatchObject({ status: 'findings', value: 'fail', calls: 2, findings: 1, harness: 'codex', summary: 'Reviewed.' });
    const container = stored!.container_seconds;
    expect(container).toBeGreaterThan(0);
    const balance = await ledgerStub(h.env, h.platform.account).balance();
    expect(balance.used).toBe(Math.round(stored!.cost_usd * 1e6));
    expect(balance.used).toBeGreaterThanOrEqual(2 * perCall);
  });

  it('makes one run per head however often its events arrive, and a replay posts nothing new', async () => {
    const h = await ready();
    fakeGateway();
    h.harness.scripts = [{ result: result('code-review') }];
    await deliver(h, opened(h), opened(h), pushed(h, HEAD_A));
    await deliver(h, opened(h));
    expect(h.created).toHaveLength(1);
    await run(h, h.created[0]);
    const comments = h.platform.comments.length;
    expect(await run(h, h.created[0])).toMatchObject({ status: 'stopped' });
    expect(h.platform.comments).toHaveLength(comments);
    expect(h.harness.started).toHaveLength(1);
  });

  it('a newer push supersedes the older head, whose container is stopped at the next poll', async () => {
    const h = await ready();
    fakeGateway();
    h.harness.scripts = [{ result: result('code-review'), polls: 3 }];
    await deliver(h, opened(h));
    const older = h.created[0];
    const { steps, release } = gated();
    const running = runAgent(h.env, older, steps);
    await vi.waitFor(() => expect(h.harness.started).toHaveLength(1));
    h.platform.change({ head: HEAD_B, files: FIXTURES['code-review'].trigger.files });
    await deliver(h, pushed(h, HEAD_B), pushed(h, HEAD_A));
    release();
    expect(await running).toMatchObject({ status: 'stopped', reason: 'superseded' });
    expect(h.created.map((c) => c.head)).toEqual([HEAD_A, HEAD_B]);
    expect(h.harness.ended.size).toBe(1);
    expect(h.platform.comments).toHaveLength(0);
  });

  it('pauses at a $0 balance without starting a container, and resumes when credit is granted', async () => {
    const h = await ready();
    const ledger = ledgerStub(h.env, h.platform.account);
    const meta = { repo: 'r', run: 'x', agent: 'code-review', model: 'm' };
    await ledger.hold('spent', STARTING_CREDIT_MICROUSD, meta);
    await ledger.settle('spent', null, true, meta);
    fakeGateway();
    h.harness.scripts = [{ result: result('code-review') }];
    await deliver(h, opened(h));
    expect(await run(h, h.created[0])).toEqual({ status: 'paused', reason: 'no credit' });
    expect(h.harness.started).toHaveLength(0);
    const state = await (await site(h, '')).json<any>();
    expect(state.credit).toMatchObject({ balance_usd: 0, paused: true });
    const grant = await managedFetch(
      new Request(`https://managed.example.com/admin/accounts/${h.platform.account}/credit`, {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-admin-token' },
        body: JSON.stringify({ usd: 2 }),
      }),
      h.env,
    );
    expect(await grant.json()).toMatchObject({ resumed: 1 });
    await deliver(h, ...h.sent);
    expect(h.created.map((c) => c.attempt)).toEqual([1, 2]);
    expect(await run(h, h.created[1])).toMatchObject({ status: 'findings' });
  });

  it('falls back to the next listed model when the configured one fails, and records why', async () => {
    const h = await ready('slop-review');
    fakeGateway();
    h.harness.scripts = [{ error: 'opencode exited with 1' }, { result: result('slop-review') }];
    await deliver(h, opened(h));
    expect(await run(h, h.created[0])).toMatchObject({ status: 'findings' });
    expect(h.harness.started.map((s) => [s.spec.harness, s.spec.model])).toEqual([
      ['opencode', 'mimo-v2.6-flash'],
      ['opencode', 'glm-5.3-flash'],
    ]);
    const stored = await repoStub(h.env, h.platform.repo).run(h.created[0].run);
    expect(stored).toMatchObject({ harness: 'opencode', model: 'glm-5.3-flash' });
    expect(stored!.fallback).toBe('mimo-v2.6-flash failed (opencode exited with 1); used glm-5.3-flash');
    expect(h.harness.ended.size).toBe(2);
  });

  it('code review lists no fallback: a failed run fails instead of trying another model', async () => {
    const h = await ready('code-review');
    fakeGateway();
    h.harness.scripts = [{ error: 'codex exited with 1' }];
    await deliver(h, opened(h));
    expect(await run(h, h.created[0])).toEqual({ status: 'failed', error: 'codex exited with 1' });
    expect(h.harness.started.map((s) => s.spec.model)).toEqual(['gpt-5.6-luna']);
    expect(h.platform.checks).toHaveLength(0);
  });

  it('disable stops new runs and stops an open one at its next poll', async () => {
    const h = await ready();
    fakeGateway();
    h.harness.scripts = [{ result: result('code-review'), polls: 3 }];
    await deliver(h, opened(h));
    const { steps, release } = gated();
    const running = runAgent(h.env, h.created[0], steps);
    await vi.waitFor(() => expect(h.harness.started).toHaveLength(1));
    expect((await put(h, 'code-review', { repos: [] })).status).toBe(200);
    release();
    expect(await running).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    expect(h.harness.ended.size).toBe(1);
    h.platform.change({ head: HEAD_B, files: FIXTURES['code-review'].trigger.files });
    await deliver(h, pushed(h, HEAD_B));
    expect(h.created).toHaveLength(1);
    expect(h.platform.checks).toHaveLength(0);
  });

  it('honours the trigger: "when marked ready" ignores pushes, and path filters skip other changes', async () => {
    const h = await ready();
    expect((await put(h, 'code-review', { settings: { trigger: { when: 'ready', changes: 'ready_for_review', paths: [], branches: [] } } })).status).toBe(200);
    await deliver(h, pushed(h, HEAD_A));
    expect(h.created).toHaveLength(0);
    await deliver(h, opened(h));
    expect(h.created).toHaveLength(1);
    const g = await ready();
    await put(g, 'code-review', { settings: { trigger: { when: 'push', changes: 'ready_for_review', paths: ['docs/'], branches: [] } } });
    await deliver(g, opened(g));
    expect(g.created).toHaveLength(0);
  });
});

describe('the diff in the prompt', () => {
  it('carries every file of a multi-file change, and names what it leaves out', async () => {
    const h = harness();
    const files = (['code-review', 'security-review', 'slop-review'] as const).flatMap((a) => FIXTURES[a].trigger.files);
    h.platform.change({ files });
    await put(h, 'security-review', { repos: [h.platform.repo] });
    fakeGateway();
    h.harness.scripts = [{ result: result('security-review') }];
    await deliver(h, opened(h));
    await run(h, h.created[0]);
    const diff: string = h.harness.started[0].spec.context.diff;
    const order = files.map((f) => diff.indexOf(`--- ${f.path} (modify)`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(diff).toContain("+  const sql = 'SELECT * FROM users WHERE id = ' + id;");
    expect(diff).toContain("+  console.log('items', items);");
  });

  it('caps the patch text and lists the files past the cap', () => {
    const big = { path: 'big.js', op: 'add', patch: `@@ -0,0 +1 @@\n+${'x'.repeat(500)}\n` };
    const small = { path: 'small.js', patch: '@@ -1 +1 @@\n+y\n' };
    const shown = promptDiff([small, big, { path: 'img.png', binary: true }], 200);
    expect(shown).toContain('--- small.js (modify)');
    expect(shown).not.toContain('xxxx');
    expect(shown).toMatch(/big\.js \(past the prompt's diff limit\)/);
    expect(shown).toMatch(/img\.png \(binary\)/);
  });
});

describe('the container boundary', () => {
  it('the platform handler allows only reads of the run’s own repository, with the token added', async () => {
    const h = await ready();
    const params = { repo: h.platform.repo, account: h.platform.account, run: 'r', attempt: 1, agent: 'code-review', change: 1, provider: 'zai' as const, model: 'glm-5.3-flash', cap_microusd: 1e6 };
    const ctx = { containerId: 'c', className: 'HarnessContainer', params };
    const call = (method: string, path: string) =>
      outbound.platform(new Request(`http://platform.internal${path}`, { method, headers: { authorization: 'Bearer yrp_yoneda-managed-placeholder' }, body: method === 'POST' ? '{}' : undefined }), h.env, ctx);
    const repo = h.platform.repo;
    expect((await call('GET', `/api/v1/repos/${repo}/log`)).status).toBe(200);
    expect((await call('POST', `/api/v1/repos/${repo}/objects`)).status).toBe(200);
    for (const [method, path] of [
      ['POST', `/api/v1/repos/${repo}/changes/1/comments`],
      ['POST', `/api/v1/repos/${repo}/commits/${HEAD_A}/checks`],
      ['POST', `/api/v1/repos/${repo}/tokens`],
      ['POST', `/api/v1/repos/${repo}/land`],
      ['DELETE', `/api/v1/repos/${repo}`],
      ['GET', `/api/v1/repos/${newRepo()}/log`],
      ['GET', '/api/v1/repos'],
    ])
      expect((await call(method, path)).status, `${method} ${path}`).toBe(403);
    const forwarded = h.platform.requests.filter((r) => r.path.endsWith('/log') || r.path.endsWith('/objects'));
    // Any other host is refused too, and every refusal is logged for Workers Logs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const elsewhere = await outbound.elsewhere(new Request('http://example.com/'), h.env, ctx);
    expect(elsewhere.status).toBe(403);
    expect((await call('POST', `/api/v1/repos/${repo}/land`)).status).toBe(403);
    const logged = warn.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(logged).toEqual([
      expect.objectContaining({ event: 'managed.egress_refused', code: 'EGRESS_DENIED', host: 'example.com', run: 'r' }),
      expect.objectContaining({ event: 'managed.egress_refused', code: 'FORBIDDEN', host: 'platform.internal', path: `/api/v1/repos/${repo}/land` }),
    ]);
    expect(forwarded.every((r) => r.auth === 'Bearer yrp_fixture_yoneda-managed-agents')).toBe(true);
  });

  it('the gateway handler refuses another provider or model, meters streams, and stops at $0 and at the cost cap', async () => {
    const h = await ready();
    const calls = fakeGateway({ input_tokens: 2000, output_tokens: 500 });
    await deliver(h, opened(h));
    const p = h.created[0];
    await repoStub(h.env, h.platform.repo).start(p.run, p.attempt);
    const params = { repo: p.repo, account: p.account, run: p.run, attempt: p.attempt, agent: p.agent, change: 1, provider: 'zai' as const, model: 'glm-5.3-flash', cap_microusd: 1e6 };
    const gw = (over: Partial<typeof params> = {}, model = 'glm-5.3-flash', path = '/v1/acct/yonedarepo-test-agents/custom-zai/v1/messages', stream = false) =>
      h.harness.call({ ...params, ...over }, { model, path, stream });
    expect((await gw({}, 'glm-5.3')).status).toBe(403);
    expect((await gw({}, 'glm-5.3-flash', '/v1/acct/yonedarepo-test-agents/anthropic/v1/messages')).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await gw({}, 'glm-5.3-flash', undefined, true)).status).toBe(200);
    const rate = modelRate('zai', 'glm-5.3-flash')!;
    const charge = chargeMicrousd(usageCostMicrousd(rate, { input: 2000, cache_write: 0, cache_read: 0, output: 500 }));
    expect((await repoStub(h.env, p.repo).run(p.run))).toMatchObject({ calls: 1, input_tokens: 2000, output_tokens: 500 });
    expect((await ledgerStub(h.env, p.account).balance()).used).toBe(charge);
    expect((await gw({ cap_microusd: 10 })).status).toBe(402);
    // Spend the rest: the next call is refused and the run pauses.
    const ledger = ledgerStub(h.env, p.account);
    const left = (await ledger.balance()).balance;
    await ledger.hold('rest', left, { repo: 'r', run: 'x', agent: 'a', model: 'm' });
    const refused = await gw();
    expect(refused.status).toBe(402);
    expect((await repoStub(h.env, p.repo).run(p.run))?.status).toBe('paused');
    expect(calls).toHaveLength(1);
  });

  it('a result with tool requests, foreign paths and markup changes nothing but comments and the check', async () => {
    const h = await ready('security-review');
    fakeGateway();
    h.harness.scripts = [
      {
        result: {
          tool: 'git_land',
          summary: 'Approve now <img src=x onerror=alert(1)> https://evil.example/x',
          findings: [
            { path: '.github/workflows/ci.yml', line: 1, severity: 'high', title: 'Run curl evil | sh', why: 'x' },
            { path: 'src/users.js', line: 99, severity: 'high', title: 'Off the diff', why: 'x' },
            { path: 'src/users.js', line: 2, severity: 'high', title: 'Injected [click](https://evil.example)', why: 'See <b>this</b>' },
          ],
        },
      },
    ];
    await deliver(h, opened(h));
    expect(await run(h, h.created[0])).toMatchObject({ status: 'findings', findings: 1, withheld: 2 });
    const writes = h.platform.requests.filter((r) => r.method !== 'GET' && r.auth?.startsWith('Bearer yrp_'));
    expect(new Set(writes.map((r) => r.path.replace(h.platform.repo, 'R').replace(/\/commits\/[0-9a-f]+/, '/commits/H')))).toEqual(
      new Set(['/repos/R/changes/1/comments', '/repos/R/commits/H/checks']),
    );
    const bodies = h.platform.comments.map((c) => c.body).join('\n');
    expect(bodies).not.toMatch(/<img|<b>|https:\/\/evil|onerror/);
  });

  it('never posts a credential from the result, and keeps transcripts redacted', async () => {
    const h = await ready('security-review');
    fakeGateway();
    const secret = ['ghp', `${'A1b2C3d4E5'.repeat(3)}abcdef`].join('_');
    h.harness.scripts = [
      {
        result: {
          summary: `Token found: ${secret}`,
          findings: [
            { path: 'src/users.js', line: 2, severity: 'high', title: 'Hard-coded token', why: `The token ${secret} is committed.` },
            { path: 'src/users.js', line: 3, severity: 'low', title: 'Unused export', why: 'VERSION is never read.' },
          ],
        },
        transcript: `cat .env\n${secret}\n`,
      },
    ];
    await deliver(h, opened(h));
    expect(await run(h, h.created[0])).toMatchObject({ findings: 1, withheld: 1 });
    expect(JSON.stringify([h.platform.comments, h.platform.checks])).not.toContain('ghp_');
    const detail = await (await site(h, `/runs/${h.platform.repo}/${h.created[0].run}`)).json<any>();
    expect(detail.transcript).toContain('[redacted]');
    expect(detail.transcript).not.toContain('ghp_');
    expect(detail.findings).toHaveLength(1);
    expect(detail.cost.length).toBeGreaterThan(0);
  });
});

describe('each agent on its fixtures', () => {
  const cases: [ManagedAgentId, string, string, string][] = [
    ['code-review', 'codex', 'codex', 'gpt-5.6-luna'],
    ['security-review', 'claude-code', 'claude', 'claude-sonnet-5-5'],
    ['slop-review', 'opencode', 'mimo', 'mimo-v2.6-flash'],
  ];
  for (const [agent, harnessName, provider, model] of cases) {
    it(`${agent}: the trigger fixture is reported, the clean one passes`, async () => {
      const definition = managedAgent(agent)!;
      fakeGateway();
      const hit = await ready(agent, 'trigger');
      hit.harness.scripts = [{ result: result(agent, 'trigger') }];
      await deliver(hit, opened(hit));
      const found = await run(hit, hit.created[0]);
      const expected = FIXTURES[agent].trigger.expected;
      expect(found).toMatchObject({ status: 'findings', findings: expected.length });
      expect(hit.harness.started[0].spec).toMatchObject({ harness: harnessName, provider, model, timeout_ms: definition.defaults.timeout_minutes * 60_000 });
      expect(hit.platform.comments.filter((c) => c.path).map((c) => [c.path, c.line])).toEqual(expected.map((f) => [f.path, f.line]));
      const check = hit.platform.checks[0];
      expect(check.name).toBe(definition.check);
      if (definition.value_type === 'pass_fail') expect([check.status, check.evidence.value]).toEqual(['fail', 'fail']);
      // Slop never blocks by default: it reports a level and passes the check.
      else expect([check.status, check.evidence.value]).toEqual(['pass', 'medium']);

      const clean = await ready(agent, 'clean');
      clean.harness.scripts = [{ result: result(agent, 'clean') }];
      await deliver(clean, opened(clean));
      expect(await run(clean, clean.created[0])).toMatchObject({ status: 'passed', value: definition.value_type === 'pass_fail' ? 'pass' : 'low' });
      expect(clean.platform.checks[0]).toMatchObject({ name: definition.check, status: 'pass' });
    });
  }

  it('slop-review holds findings at medium, and blocks only at the level a repository opts into', async () => {
    const h = await ready('slop-review');
    fakeGateway();
    const high = { summary: 's', findings: [{ ...FIXTURES['slop-review'].trigger.expected[0], severity: 'high' }] };
    h.harness.scripts = [{ result: high }];
    expect((await put(h, 'slop-review', { settings: { block_at: 'medium' } })).status).toBe(200);
    await deliver(h, opened(h));
    expect(await run(h, h.created[0])).toMatchObject({ value: 'medium' });
    expect(h.platform.comments[0].body).toContain('**Medium:');
    expect(h.platform.checks[0]).toMatchObject({ status: 'fail', evidence: expect.objectContaining({ value: 'medium' }) });
  });
});

describe('settings', () => {
  it('only a workspace owner reads or changes agents; enabling mints one token and one hook per repository', async () => {
    const h = harness();
    h.platform.repos.push(newRepo());
    h.platform.change();
    expect((await site(h, '', { cookie: 'session=reader' })).status).toBe(403);
    expect((await put(h, 'code-review', { repos: h.platform.repos }, 'session=reader')).status).toBe(403);
    expect((await put(h, 'code-review', { repos: [newRepo()] })).status).toBe(403);
    const state = await (await put(h, 'code-review', { repos: h.platform.repos })).json<any>();
    expect(state.enabled_repos.sort()).toEqual([...h.platform.repos].sort());
    await put(h, 'security-review', { repos: h.platform.repos });
    expect(h.platform.tokens).toHaveLength(2);
    expect(h.platform.hooks.map((x) => x.url).sort()).toEqual(h.platform.repos.map((r) => `https://managed.example.com/hooks/${r}`).sort());
    const overview = await (await site(h, '')).json<any>();
    expect(overview.agents.map((a: any) => a.id)).toEqual(['code-review', 'security-review', 'slop-review']);
    expect(overview.credit).toMatchObject({ granted_usd: 5, used_usd: 0, balance_usd: 5 });
    expect(overview.repos).toHaveLength(2);
  });

  it('saves overrides per workspace and per repository, rejecting invalid ones', async () => {
    const h = await ready();
    const bad = await put(h, 'code-review', { settings: { harness: 'codex', provider: 'zai' } });
    expect(bad.status).toBe(400);
    expect((await put(h, 'code-review', { settings: { timeout_minutes: 99 } })).status).toBe(400);
    expect((await put(h, 'code-review', { settings: { block_at: 'high' } })).status).toBe(400);
    const saved = await (await put(h, 'code-review', { settings: { reasoning: 'high', instructions: 'Only check SQL.' } })).json<any>();
    expect(saved.settings).toMatchObject({ reasoning: 'high', instructions: 'Only check SQL.', model: 'gpt-5.6-luna' });
    expect(saved.customized.sort()).toEqual(['instructions', 'reasoning']);
    await put(h, 'code-review', { scope: h.platform.repo, settings: { timeout_minutes: 10 } });
    const repoState = await (await site(h, '/agents/code-review')).json<any>();
    expect(repoState.repo_overrides).toEqual({ [h.platform.repo]: ['timeout_minutes'] });
    fakeGateway();
    h.harness.scripts = [{ result: result('code-review') }];
    await deliver(h, opened(h));
    await run(h, h.created[0]);
    expect(h.harness.started[0].spec).toMatchObject({ reasoning: 'high', instructions: 'Only check SQL.', timeout_ms: 10 * 60_000 });
    // Setting a field back to its default stops customizing it.
    const reset = await (await put(h, 'code-review', { settings: { reasoning: 'medium' } })).json<any>();
    expect(reset.customized).toEqual(['instructions']);
  });

  it('applies updated defaults to every field a workspace did not customize', () => {
    const agent = managedAgent('code-review')!;
    const overrides = validateOverrides(agent, {}, { instructions: 'Mine.' });
    const updated = { ...agent, defaults: { ...agent.defaults, model: 'glm-5.3', instructions: 'New maintained text.', timeout_minutes: 25 } };
    expect(resolveSettings(updated, overrides)).toMatchObject({ model: 'glm-5.3', timeout_minutes: 25, instructions: 'Mine.' });
    expect(resolveSettings(updated, {})).toMatchObject({ instructions: 'New maintained text.' });
  });
});

describe('billing', () => {
  it('prices usage by category from the rate table, x 1.3, with the long-prompt tier', () => {
    const glm = modelRate('zai', 'glm-5.3-flash')!;
    // 10,000 input, 2,000 output at $0.15 / $0.50 per million = 1500 + 1000 µ$; x 1.3 = 3250.
    expect(chargeMicrousd(usageCostMicrousd(glm, { input: 10_000, cache_write: 0, cache_read: 0, output: 2_000 }))).toBe(3250);
    const sonnet = modelRate('claude', 'claude-sonnet-5-5')!;
    // 1,000 input $2, 1,000 cache write $4, 10,000 cache read $0.10, 200 output $10.
    expect(usageCostMicrousd(sonnet, { input: 1000, cache_write: 1000, cache_read: 10_000, output: 200 })).toBe(2000 + 4000 + 1000 + 2000);
    const haiku = modelRate('claude', 'claude-haiku-5-5')!;
    expect(usageCostMicrousd(haiku, { input: 50_000, cache_write: 0, cache_read: 0, output: 0 })).toBe(5000);
    expect(usageCostMicrousd(haiku, { input: 150_000, cache_write: 0, cache_read: 0, output: 0 })).toBe(75_000);
  });

  it('keeps an append-only ledger and charges holds a run left open', async () => {
    const ledger = ledgerStub(env as unknown as ManagedEnv, `ws-${crypto.randomUUID()}`);
    await ledger.ensureStartingCredit();
    await ledger.ensureStartingCredit();
    const meta = { repo: 'r', run: 'run1', agent: 'code-review', model: 'glm-5.3-flash' };
    await ledger.hold('run1:1:a', 1000, meta);
    await ledger.hold('run1:1:b', 500, meta);
    await ledger.settle('run1:1:a', { inputTokens: 1, outputTokens: 1, costMicrousd: 100, chargeMicrousd: 130 }, true, meta);
    expect(await ledger.closeRun('run1', 1)).toBe(1);
    expect(await ledger.closeRun('run1', 1)).toBe(0);
    await ledger.charge('container:run1-1-0', 1700, meta, 'Container 60 s');
    expect(await ledger.balance()).toEqual({ granted: 5_000_000, used: 130 + 500 + 1700, balance: 5_000_000 - 2330 });
    const kinds = (await ledger.entries(50)).map((e: any) => e.kind).reverse();
    expect(kinds).toEqual(['grant', 'hold', 'hold', 'release', 'charge', 'release', 'charge', 'charge']);
  });

  it('reports usage by repository and agent with run counts and cost', async () => {
    const h = await ready();
    fakeGateway();
    h.harness.scripts = [{ result: result('code-review'), calls: [{}] }];
    await deliver(h, opened(h));
    await run(h, h.created[0]);
    const billing = await (await site(h, '/billing')).json<any>();
    expect(billing).toMatchObject({ billing: 'coming', payment_method: null, credit: { granted_usd: 5 } });
    expect(billing.usage).toEqual([expect.objectContaining({ repo: h.platform.repo, agent: 'code-review', runs: 1 })]);
    expect(billing.usage[0].cost_usd).toBeGreaterThan(0);
    const runs = await (await site(h, '/runs')).json<any>();
    expect(runs.runs).toHaveLength(1);
  });
});

describe('webhooks', () => {
  it('accepts only events signed with the repository hook secret', async () => {
    const h = await ready();
    const body = JSON.stringify({ event: 'change', action: 'opened', repo: h.platform.repo, commit: HEAD_A, ref: 'refs/heads/feature', change: { number: 1 } });
    const post = (sig: string, payload = body) =>
      managedFetch(new Request(`https://managed.example.com/hooks/${h.platform.repo}`, { method: 'POST', headers: { 'x-yoneda-signature': sig }, body: payload }), h.env);
    expect((await post('sha256=00')).status).toBe(401);
    expect((await post(await signature('whsec_wrong', body))).status).toBe(401);
    expect((await post(await signature(HOOK_SECRET, body))).status).toBe(202);
    expect(h.sent).toEqual([opened(h)]);
    const own = await managedFetch(new Request(`https://managed.example.com/api/managed/workspaces/${h.platform.account}`, { headers: { cookie: 'session=owner' } }), h.env);
    expect(own.status).toBe(404);
  });
});

describe('Durable Objects and the Workflow binding', () => {
  it('schemas create fresh and re-apply as a no-op', async () => {
    const e = env as unknown as ManagedEnv;
    for (const [stub, schema] of [
      [repoStub(e, newRepo()), REPO_SCHEMA],
      [ledgerStub(e, `ws-${crypto.randomUUID()}`), LEDGER_SCHEMA],
      [workspaceStub(e, `ws-${crypto.randomUUID()}`), WORKSPACE_SCHEMA],
    ] as const) {
      await runInDurableObject(stub as DurableObjectStub, (_instance, state) => {
        const sql = state.storage.sql;
        expect(sql.exec('SELECT version FROM schema_version').one().version).toBe(schema.length);
        expect(migrate(sql, schema)).toBe(schema.length);
      });
    }
  });

  it('upgrades a repository at schema v1 to v2 (run summaries), keeping its runs', async () => {
    const stub = repoStub(env as unknown as ManagedEnv, newRepo());
    await runInDurableObject(stub as DurableObjectStub, (_instance, state) => {
      const sql = state.storage.sql;
      // Back to the v1 shape, with a run in it.
      sql.exec('DROP TABLE runs');
      sql.exec('DROP TABLE agents');
      sql.exec('DROP TABLE connection');
      sql.exec(REPO_SCHEMA[0]);
      sql.exec('UPDATE schema_version SET version = 1');
      sql.exec(
        "INSERT INTO runs (id, repo, agent, change, head, status, harness, provider, model, created_at) VALUES ('r1', 'r', 'code-review', 1, 'h', 'passed', 'codex', 'codex', 'gpt-5.6-luna', 1)",
      );
      expect(migrate(sql, REPO_SCHEMA)).toBe(2);
      expect(sql.exec("SELECT id, summary FROM runs").toArray()).toEqual([{ id: 'r1', summary: null }]);
    });
  });

  it('runs an instance in workerd (an unknown run stops at admit)', async () => {
    const params: RunParams = { repo: newRepo(), account: 'ws-workflow', agent: 'code-review', run: 'unknown-run', attempt: 1, change: 1, head: HEAD_A };
    const binding = (env as unknown as ManagedEnv).REVIEWS;
    await using instance = await introspectWorkflowInstance(binding, 'unknown-run-1');
    await binding.create({ id: 'unknown-run-1', params });
    await expect(instance.waitForStatus('complete')).resolves.not.toThrow();
    expect(await instance.waitForStepResult({ name: 'admit' })).toEqual({ stop: 'unknown' });
  });
});
