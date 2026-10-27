// The eval Worker's P9 arm against the real platform with FAKE models: agent bases, read
// sets and landing order follow the scheduler, and the platform's post-land combined
// check decides acceptance (here an arity check standing in for the hosted type check).
import { expect, it } from 'vitest';
import { executeCheckRun } from '../../cloudflare/worker/repo-checks';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, queued, runners, scoped, signup, usePlatformFixture } from '../workers/repo-fixture';
import { call, evalEnv, fakeModel, message, use } from './fixture';

usePlatformFixture();

const PRICING = 'export function price(amount: number): number {\n  return amount;\n}\n';
const PRICING_V2 = "export function price(amount: number, currency: string): number {\n  return currency === 'usd' ? amount : amount * 2;\n}\n\nexport function quote(amount: number): number {\n  return price(amount, 'usd');\n}\n";
const CART = 'export function total(items: number[]): number {\n  return items.length;\n}\n';

/** Combined check: every price() call passes as many arguments as price() declares. */
function arityCheck(job: any) {
  const text = job.files.map((f: any) => atob(f.data_b64)).join('\n');
  const declared = /function price\(([^)]*)\)/.exec(text)?.[1].split(',').length ?? 0;
  const calls = [...text.matchAll(/(?<!function )price\(([^)]*)\)/g)].map((m) => m[1].split(',').length);
  const ok = calls.every((n) => n === declared);
  return { outcome: ok ? 'pass' : 'fail', exit_code: ok ? 0 : 1, timed_out: false, duration_ms: 1, output_bytes: 0, output_sha256: '0'.repeat(64), output_tail: '' };
}
/** Executor failures to inject before checks run (like a container that died; a full
 * container pool only delays a run, it never errors it). */
const capacity = { failures: 0 };
const runner = async (job: any) => {
  if (capacity.failures > 0 && capacity.failures--) throw new Error('Container exited with unexpected exit code: 137');
  return arityCheck(job);
};
const checks = { ...scoped, CHECK_RUNNERS: runners(runner) } as unknown as Env;
// The platform's queue consumer, in-process: post-land checks run after each API request.
const platform = {
  fetch: async (request: Request) => {
    const response = await platformFetch(request, checks);
    for (const m of queued.splice(0).filter((q) => q.kind === 'platform_check')) await executeCheckRun(checks, m);
    return response;
  },
};

/** Fake agents: A rewrites pricing; B reads pricing at its base and calls price() to match. */
function players() {
  return (body: any) => {
    const isA = body.messages[0].content.includes('second required parameter');
    const turn = body.messages.length;
    if (turn === 1) return message([use('read_file', { path: 'src/pricing.ts' })]);
    if (turn === 3) {
      if (isA) return message([use('write_file', { path: 'src/pricing.ts', content: PRICING_V2 })]);
      const twoArgs = String(body.messages[2].content[0].content).includes('currency');
      const cart = `import { price } from './pricing';\n${CART}\nexport function shipping(): number {\n  return ${twoArgs ? "price(5, 'usd')" : 'price(5)'};\n}\n`;
      return message([use('write_file', { path: 'src/cart.ts', content: cart })]);
    }
    return message([use('finish', {})]);
  };
}

async function scenario(name: string, scheduler: string) {
  const owner = { cookie: await signup(name) };
  const policy = { required_checks: [], approvals: 0, runners: { combined: { command: ['check-arity'] } } };
  const files = [file('src/pricing.ts', PRICING), file('src/cart.ts', CART)];
  const created = await api('/repos', owner, { body: { name, policy, files, author } }, checks);
  const repo = created.body.id;
  const mint = async (n: string) => (await api(`/repos/${repo}/tokens`, owner, { body: { name: n, scopes: ['read', 'write', 'land'] } }, checks)).body.token;
  const tokens = { a: await mint('a'), b: await mint('b') };
  fakeModel(players());
  const body = { run: 'p9', provider: 'zai', scheduler, repo, tokens, base: { commit: created.body.commit, version: created.body.version } };
  const response = await call('/v1/p9', body, undefined, evalEnv({ EVAL_SPEND_CAP_MICROUSD: '8000', PLATFORM: platform }));
  expect(response.status).toBe(200);
  return (await response.json()) as any;
}

it('file-disjoint scheduling lands both and the post-land combined check fails', async () => {
  const disjoint = await scenario('evaldisjoint', 'disjoint');
  expect(disjoint).toMatchObject({ scheduler: 'file-disjoint', landed: 2, head_check: 'fail', stale_read_conflicts: 0, accepted: 0, agent_attempts: 2, usd_per_accepted: 'not finitely estimated' });
  expect(disjoint.repairs_proposed).toBeGreaterThan(0);
  expect(disjoint.attempts[1].read_set).toEqual([]);
});

it('dependency-aware scheduling turns the break into a stale-read conflict that B redoes', async () => {
  const aware = await scenario('evalaware', 'aware');
  expect(aware).toMatchObject({ head_check: 'pass', stale_read_conflicts: 1, accepted: 2, agent_attempts: 3, repairs_proposed: 0 });
  // The declared read set is what B's tools returned, not anything B said.
  expect(aware.attempts[1].read_set).toEqual(['src/pricing.ts']);
  expect(aware.landings.map((l: any) => l.error ?? 'landed')).toEqual(['landed', 'CONFLICT', 'landed']);
});

it('planned scheduling runs B after A, so nothing is redone', async () => {
  const planned = await scenario('evalplanned', 'planned');
  expect(planned).toMatchObject({ head_check: 'pass', stale_read_conflicts: 0, accepted: 2, agent_attempts: 2, plan: { stages: [['pricing'], ['shipping']] } });
  expect(planned.usage.requests).toBe(6);
  expect(planned.usd_per_accepted).toBeCloseTo(planned.usage.usd / 2, 6);
});

it('re-requests a check that errored in the executor and counts it, instead of judging it', async () => {
  // Import, A's landing and the head each lose their first run to the executor.
  capacity.failures = 3;
  const planned = await scenario('evalcapacity', 'planned');
  expect(planned).toMatchObject({ head_check: 'pass', accepted: 2, check_executor_errors: 1 });
});
