// The N9 eval Worker against the real platform in workerd, with FAKE model endpoints (no
// keys, no paid inference): bearer auth fails closed, inputs are bounded, the spend cap
// refuses requests before they are sent, rate limits back off and are counted, and an
// arm's metrics come from the platform (landing + diff oracle), not from the model.
import { expect, it } from 'vitest';
import { capOf, HARD_CAP_MICROUSD } from '../../cloudflare/eval/ledger';
import { codebase, pathOf, render } from '../../cloudflare/eval/study';
import { api, author, file, signup, usePlatformFixture } from '../workers/repo-fixture';
import { call, evalEnv, fakeModel, message, SECRET, use } from './fixture';

usePlatformFixture();
const SEED = 20261019;
const symbols = codebase(SEED);

/** A scripted "model": read the closure by symbol, edit the target by handle, finish. */
function symbolPlayer(usage?: { input_tokens: number; output_tokens: number }) {
  return (body: any) => {
    const target = /function (f\d+_\d+) must/.exec(body.messages[0].content)?.[1] ?? '';
    const spec = symbols.find((s) => s.name === target)!;
    const turn = body.messages.length;
    if (turn === 1)
      return message([target, ...spec.callees].map((name) => use('read_symbol', { path: pathOf('modules', symbols.find((s) => s.name === name)!), symbol: name })), usage);
    if (turn === 3) {
      const source = body.messages[2].content[0].content as string;
      return message([use('edit_symbol', { path: pathOf('modules', spec), symbol: target, replacement: source.replace(/(return [^;]*);/, '$1 + 1;') })], usage);
    }
    return message([use('finish', {})], usage);
  };
}

async function armRepo(name: string) {
  const owner = { cookie: await signup(name) };
  const files = render('modules', symbols).map(([p, t]) => file(p, t));
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files, author } });
  const token = (await api(`/repos/${created.body.id}/tokens`, owner, { body: { name: 'model-agent', scopes: ['read', 'write', 'land'] } })).body.token;
  return { owner, repo: created.body.id as string, token: token as string };
}
const arm = (repo: { repo: string; token: string }, over: Record<string, unknown> = {}) => ({
  run: 'test-run',
  provider: 'zai',
  layout: 'modules',
  interface: 'symbol',
  seed: SEED,
  tasks: 2,
  drop_rate: 0,
  ...repo,
  ...over,
});

it('refuses unauthenticated, unconfigured and out-of-bounds requests before any model call', async () => {
  const seen = fakeModel(() => message([]));
  expect((await call('/v1/spend', undefined, null)).status).toBe(401);
  expect((await call('/v1/spend', undefined, 'f'.repeat(40))).status).toBe(401);
  expect((await call('/v1/spend', undefined, SECRET, evalEnv({ EVAL_TOKEN: undefined }))).status).toBe(401);
  expect((await call('/v1/spend', undefined, 'short', evalEnv({ EVAL_TOKEN: 'short' }))).status).toBe(401);
  const spend = await call('/v1/spend');
  expect(await spend.json()).toMatchObject({ cap_microusd: 8000, hard_cap_microusd: HARD_CAP_MICROUSD, settled_microusd: 0 });
  const repo = { repo: `r${'0'.repeat(20)}`, token: `yrp_${'a'.repeat(30)}` };
  for (const bad of [{ provider: 'claude' }, { tasks: 99 }, { drop_rate: 2 }, { layout: 'flat' }, { max_turns: 50 }, { token: 'sk-raw' }])
    expect((await call('/v1/arms', arm(repo, bad))).status).toBe(400);
  const unconfigured = await call('/v1/smoke', { run: 'x', provider: 'zai' }, SECRET, evalEnv({ EVAL_SPEND_CAP_MICROUSD: undefined }));
  expect((await unconfigured.json()) as any).toMatchObject({ error: { code: 'NOT_CONFIGURED' } });
  expect(seen).toHaveLength(0);
  // Configuration can lower the cap, never raise it past the code ceiling.
  expect([capOf('999999999'), capOf('abc'), capOf('-1'), capOf('2500000')]).toEqual([HARD_CAP_MICROUSD, 0, 0, 2_500_000]);
});

it('runs an arm through the public platform API and judges it by the landed diff', async () => {
  const repo = await armRepo('evalshape');
  const seen = fakeModel(symbolPlayer());
  const response = await call('/v1/arms', arm(repo));
  const result = (await response.json()) as any;
  expect(response.status).toBe(200);
  expect(result).toMatchObject({
    label: expect.stringMatching(/^REAL MODEL: glm-5\.3-flash via zai \(coding_plan\), \d{4}-\d\d-\d\d$/),
    tasks: 2,
    accepted: 2,
    closure_recall: 1,
    edit_expansion: 1,
    stopped: null,
    usage: { requests: 6, failures: { rate_limited: 0, provider_error: 0, timeout: 0 } },
    prompts_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(result.usage.usd).toBeCloseTo(6 * (3000 * 0.15 + 100 * 0.5) / 1e6, 9);
  expect(result.usd_per_accepted).toBeCloseTo(result.usage.usd / 2, 6);
  expect(result.exposure_precision).toBeGreaterThan(0.5);
  // Cheapest model, low effort, capped output, key only in the auth header.
  expect(seen[0].url).toBe('https://api.z.ai/api/anthropic/v1/messages');
  expect(seen[0].headers.authorization).toBe('Bearer zai-test-key');
  expect(seen[0].body).toMatchObject({ model: 'glm-5.3-flash', max_tokens: 2048, output_config: { effort: 'low' } });
  expect(JSON.stringify(result)).not.toContain('zai-test-key');
  const log = await api(`/repos/${repo.repo}/log?ref=main&limit=5`, repo.owner);
  expect(log.body.commits).toHaveLength(3);
  expect(await (await call('/v1/spend')).json()).toMatchObject({ requests: 6, open_reservations_microusd: 0 });
});

it('counts a model that only claims success as a failure with no finite cost', async () => {
  const repo = await armRepo('evalclaim');
  fakeModel(() => message([{ type: 'text', text: 'Done: I added + 1 to the function.' }]));
  const result = (await (await call('/v1/arms', arm(repo, { tasks: 1 }))).json()) as any;
  expect(result).toMatchObject({ accepted: 0, cost_per_accepted: 'not finitely estimated', usd_per_accepted: 'not finitely estimated' });
  expect(result.attempts[0]).toMatchObject({ commit: null, stop: 'finished', landed: false });
});

it('backs off on rate limits, counts every failure, and gives up after the retry cap', async () => {
  const recovering = await armRepo('evalratelimit');
  const player = symbolPlayer();
  const seen = fakeModel((body, n) => {
    if (n === 1) return new Response('{"error":{"type":"rate_limit_error"}}', { status: 429, headers: { 'retry-after': '0' } });
    if (n === 2) return Response.json({ error: { code: '1302', message: 'High concurrency usage' } }, { status: 400 });
    return player(body);
  });
  const ok = (await (await call('/v1/arms', arm(recovering, { provider: 'mimo', tasks: 1 }))).json()) as any;
  expect(ok).toMatchObject({ route: 'token_plan_sgp', model: 'mimo-v2.6-flash', accepted: 1, usage: { requests: 5, failures: { rate_limited: 2 } } });
  expect(ok.usage.errors).toHaveLength(2);
  expect(seen[0].url).toBe('https://token-plan-sgp.xiaomimimo.com/anthropic/v1/messages');
  expect(seen[0].headers['api-key']).toBe('tp-test-key');
  expect(seen[0].body.thinking).toEqual({ type: 'disabled' });

  const blocked = await armRepo('evalblocked');
  fakeModel(() => new Response('{}', { status: 429 }));
  const failed = (await (await call('/v1/arms', arm(blocked, { tasks: 1 }))).json()) as any;
  expect(failed).toMatchObject({ accepted: 0, usd_per_accepted: 'not finitely estimated', usage: { requests: 4, usd: 0, failures: { rate_limited: 4 } } });
  expect(failed.attempts[0].stop).toBe('model_error');
});

it('stops an arm when the projected spend would exceed the cap, before sending', async () => {
  const repo = await armRepo('evalcap');
  // Each answer reports 20k input tokens (3000 micro-USD); the third request would pass 8000.
  // The edit was already committed by then, so the first task still lands; the arm stops.
  const seen = fakeModel(symbolPlayer({ input_tokens: 20_000, output_tokens: 0 }));
  const result = (await (await call('/v1/arms', arm(repo))).json()) as any;
  expect(seen).toHaveLength(2);
  expect(result).toMatchObject({ stopped: 'spend_cap', tasks: 1, tasks_planned: 2, accepted: 1, usage: { requests: 2, usd: 0.006 } });
  expect(result.attempts[0].stop).toBe('spend_cap');
  expect(await (await call('/v1/spend')).json()).toMatchObject({ settled_microusd: 6000, open_reservations_microusd: 0, refused: 1 });
  const smoke = (await (await call('/v1/smoke', { run: 'x', provider: 'zai' })).json()) as any;
  expect(smoke).toMatchObject({ ok: false, error: 'spend_cap' });
});

it('smoke-tests a route with one fixed request and reports provider errors without retrying', async () => {
  fakeModel((_body, n) => (n === 1 ? message([{ type: 'text', text: 'ok' }], { input_tokens: 12, output_tokens: 2 }) : new Response('{"error":{"message":"invalid key"}}', { status: 401 })));
  expect(await (await call('/v1/smoke', { run: 'x', provider: 'zai' })).json()).toMatchObject({ ok: true, reply: 'ok', route: 'coding_plan' });
  expect(await (await call('/v1/smoke', { run: 'x', provider: 'mimo' })).json()).toMatchObject({ ok: false, error: 'provider_error', usage: { requests: 1, failures: { provider_error: 1 } } });
});
