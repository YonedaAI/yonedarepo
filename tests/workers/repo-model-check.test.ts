// Model checks (policy runner kind `model`) in workerd: one structured call per run to a
// stubbed review model with the platform's own key, recorded as a normal check result that
// gates landing. No live model calls.
import { expect, it, vi } from 'vitest';
import { executeCheckRun } from '../../cloudflare/worker/repo-checks';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, executed, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const MODEL_URL = 'https://api.z.ai/api/anthropic/v1/messages';
const env = { ...scoped, REVIEW_MODEL_KEY: { get: async () => 'platform-review-test-key' } } as unknown as Env;
const RUBRIC = 'Fail when SQL is built by concatenating or formatting user input.';

/** Answers review-model calls with `answer(user prompt)`, recording each request. */
function stubModel(answer: (prompt: string) => string | Response) {
  const calls: { body: any; headers: Headers }[] = [];
  const fixture = vi.mocked(globalThis.fetch).getMockImplementation();
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== MODEL_URL) return fixture!(input, init);
    const body = JSON.parse(String(init?.body));
    calls.push({ body, headers: new Headers(init?.headers) });
    const out = answer(body.messages[0].content);
    if (out instanceof Response) return out;
    return Response.json({
      content: [{ type: 'thinking', thinking: 'reviewing' }, { type: 'text', text: out }],
      usage: { input_tokens: 2_000, output_tokens: 200 },
    });
  });
  return calls;
}

/** A reviewer that fails string-built SQL and passes everything else. */
const reviewer = (prompt: string) =>
  /\+.*"SELECT[^"]*"\s*\+/.test(prompt)
    ? JSON.stringify({
        verdict: 'fail',
        score: 8,
        findings: [{ path: 'db.py', line: 2, severity: 'high', message: 'SQL built by string concatenation' }],
      })
    : JSON.stringify({ verdict: 'pass', score: 96, findings: [] });

async function securedRepo(name: string, runner: Record<string, unknown> = {}) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, {
    body: { policy: { required_checks: [], approvals: 0 }, files: [file('db.py', 'def find(db, name):\n    return None\n')], author },
  });
  const repo = `/repos/${created.body.id}`;
  const policy = {
    required_checks: ['security'],
    approvals: 0,
    runners: { security: { kind: 'model', rubric: RUBRIC, ...runner } },
  };
  expect((await api(`${repo}/policy`, owner, { method: 'PUT', body: { policy } })).status).toBe(200);
  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'bot', scopes: ['read', 'write', 'land', 'check'] } });
  return { owner, repo, bot: { token: minted.body.token as string } };
}

const commit = (repo: string, bot: { token: string }, text: string, message: string) =>
  api(`${repo}/commits`, bot, { body: { ref: 'main', changes: [file('db.py', text)], message, author } });
const runs = () => queued.filter((m) => m.kind === 'platform_check');
const land = (repo: string, bot: { token: string }, sha: string) =>
  api(`${repo}/land`, bot, { body: { ref: 'main', commit: sha } });

it('fails a seeded vulnerable change, blocking land, and passes and lands the fix', async () => {
  const calls = stubModel(reviewer);
  const { repo, bot } = await securedRepo('mona');
  const bad = await commit(repo, bot, 'def find(db, name):\n    return db.execute("SELECT * FROM users WHERE name = \'" + name + "\'")\n', 'Look up users by name');
  expect(bad.body.check_runs[0]).toMatchObject({ name: 'security', status: 'queued' });
  // B2(a) holds for model runners: nobody posts the runner's check by hand.
  expect((await api(`${repo}/commits/${bad.body.commit}/checks`, bot, { body: { name: 'security', status: 'pass' } })).status).toBe(403);
  expect(await executeCheckRun(env, runs()[0])).toEqual({});

  // Exactly one call, no tools, the platform's key, the diff and the intent.
  expect(calls).toHaveLength(1);
  expect(calls[0].headers.get('authorization')).toBe('Bearer platform-review-test-key');
  expect(calls[0].body).toMatchObject({ model: 'glm-5.3-flash', max_tokens: 4096 });
  expect(calls[0].body.tools).toBeUndefined();
  expect(calls[0].body.system).toContain(RUBRIC);
  expect(calls[0].body.messages[0].content).toContain('Look up users by name');
  expect(calls[0].body.messages[0].content).toContain('diff --git a/db.py b/db.py (modify)');
  expect(executed).toHaveLength(0);

  const failed = await api(`${repo}/commits/${bad.body.commit}`, bot);
  expect(failed.body.gates.failing_checks).toEqual(['security']);
  expect(failed.body.checks[0]).toMatchObject({ name: 'security', status: 'fail', principal: 'platform:checks' });
  const evidence = JSON.parse(failed.body.checks[0].evidence);
  expect(evidence).toMatchObject({ kind: 'model', verdict: 'fail', score: 8, attempts: 1, truncated: false });
  expect(evidence.findings[0]).toMatchObject({ path: 'db.py', severity: 'high' });
  // 2,000 input tokens at $0.15/M + 200 output at $0.50/M.
  expect(evidence.cost_microusd).toBe(400);
  expect((await land(repo, bot, bad.body.commit)).body.error.code).toBe('NOT_READY');

  const fixed = await commit(repo, bot, 'def find(db, name):\n    return db.execute("SELECT * FROM users WHERE name = ?", (name,))\n', 'Use a bound parameter');
  expect(await executeCheckRun(env, runs()[1])).toEqual({});
  const passed = await api(`${repo}/commits/${fixed.body.commit}`, bot);
  expect(passed.body.checks[0]).toMatchObject({ status: 'pass' });
  expect(JSON.parse(passed.body.checks[0].evidence)).toMatchObject({ verdict: 'pass', score: 96 });
  expect((await land(repo, bot, fixed.body.commit)).body.landed).toBe(true);
  expect(calls).toHaveLength(2);
});

it('retries a malformed answer once, then errors and stays blocked', async () => {
  const calls = stubModel(() => 'Looks fine to me!');
  const { repo, bot } = await securedRepo('nell');
  const made = await commit(repo, bot, 'x = 1\n', 'Tidy');
  expect(await executeCheckRun(env, runs()[0])).toEqual({});
  expect(calls).toHaveLength(2);
  const run = await api(`${repo}/check-runs/${runs()[0].job_id}`, bot);
  expect(run.body.status).toBe('errored');
  expect(run.body.result).toMatchObject({ kind: 'model', code: 'MODEL_CHECK_ERROR', attempts: 2, cost_microusd: 800 });
  const detail = await api(`${repo}/commits/${made.body.commit}`, bot);
  expect(detail.body.gates.missing_checks).toEqual(['security']);
  expect((await land(repo, bot, made.body.commit)).body.error.code).toBe('NOT_READY');
});

it('fails an oversized diff closed without calling the model', async () => {
  const calls = stubModel(reviewer);
  const { repo, bot } = await securedRepo('opal');
  const lines = Array.from({ length: 2_000 }, (_, i) => `value_${i} = ${'1'.repeat(30)}\n`).join('');
  const made = await commit(repo, bot, lines, 'Generated table');
  expect(await executeCheckRun(env, runs()[0])).toEqual({});
  expect(calls).toHaveLength(0);
  const detail = await api(`${repo}/commits/${made.body.commit}`, bot);
  expect(detail.body.gates.failing_checks).toEqual(['security']);
  const evidence = JSON.parse(detail.body.checks[0].evidence);
  expect(evidence).toMatchObject({ truncated: true, cost_microusd: 0 });
  expect(evidence.findings[0].message).toBe('diff too large for model review');
  expect((await land(repo, bot, made.body.commit)).body.error.code).toBe('NOT_READY');
});

it('records an error, not a pass, when the platform key is missing', async () => {
  const calls = stubModel(reviewer);
  const { repo, bot } = await securedRepo('pia');
  const made = await commit(repo, bot, 'x = 2\n', 'Tidy');
  expect(await executeCheckRun(scoped, runs()[0])).toEqual({});
  expect(calls).toHaveLength(0);
  const run = await api(`${repo}/check-runs/${runs()[0].job_id}`, bot);
  expect(run.body).toMatchObject({ status: 'errored', result: { code: 'MODEL_KEY_MISSING' } });
  expect((await api(`${repo}/commits/${made.body.commit}`, bot)).body.gates.missing_checks).toEqual(['security']);
});
