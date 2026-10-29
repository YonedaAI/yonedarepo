// N9 P9 demo: two tasks on disjoint files with a semantic dependency. A changes price()'s
// signature (and its own callers); B adds a new price() call in another file. Each passes
// alone. File-disjoint scheduling lands both and only the post-land combined check sees
// the break; dependency-aware scheduling (B declares what it read) turns it into a stale-
// read conflict that B redoes on the new head; planned scheduling (git_plan over declared
// symbol sets) runs B after A, so nothing is redone. Scripted agents; no model calls.
import { expect, it } from 'vitest';
import { executeCheckRun } from '../../cloudflare/worker/repo-checks';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, queued, runners, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const PRICING = 'export function price(amount: number): number {\n  return amount;\n}\n';
const PRICING_V2 = "export function price(amount: number, currency: string): number {\n  return currency === 'usd' ? amount : amount * 2;\n}\n\nexport function quote(amount: number): number {\n  return price(amount, 'usd');\n}\n";
const CART = 'export function total(items: number[]): number {\n  return items.length;\n}\n';

/** Combined check: every price() call passes as many arguments as price() declares. */
function arityCheck(job: any) {
  const text = job.files.map((f: any) => new TextDecoder().decode(f.data)).join('\n');
  const declared = /function price\(([^)]*)\)/.exec(text)?.[1].split(',').length ?? 0;
  const calls = [...text.matchAll(/(?<!function )price\(([^)]*)\)/g)].map((m) => m[1].split(',').length);
  const ok = calls.every((n) => n === declared);
  return { outcome: ok ? 'pass' : 'fail', exit_code: ok ? 0 : 1, timed_out: false, duration_ms: 1, output_bytes: 0, output_sha256: '0'.repeat(64), output_tail: ok ? '' : 'price() arity mismatch\n' };
}
const env = { ...scoped, CHECK_RUNNERS: runners(async (job) => arityCheck(job)) } as unknown as Env;

type Scheduler = 'disjoint' | 'aware' | 'planned';
const LABELS: Record<Scheduler, string> = {
  disjoint: 'file-disjoint',
  aware: 'dependency-aware (read sets)',
  planned: 'planned (git_plan stages)',
};

async function scenario(name: string, scheduler: Scheduler) {
  const declareReads = scheduler === 'aware';
  const owner = { cookie: await signup(name) };
  const policy = { required_checks: [], approvals: 0, runners: { combined: { command: ['check-arity'] } } };
  const created = await api('/repos', owner, { body: { name, policy, files: [file('src/pricing.ts', PRICING), file('src/cart.ts', CART)], author } }, env);
  const repo = `/repos/${created.body.id}`;
  const base = created.body.commit;
  const agentA = { token: (await api(`${repo}/tokens`, owner, { body: { name: 'a', scopes: ['read', 'write', 'land'] } }, env)).body.token };
  const agentB = { token: (await api(`${repo}/tokens`, owner, { body: { name: 'b', scopes: ['read', 'write', 'land'] } }, env)).body.token };
  let attempts = 0;
  // Agent B reads price()'s signature, then adds a call in its own file.
  const runB = async (parent: string) => {
    attempts++;
    const pricing = (await api(`${repo}/blob?path=src/pricing.ts&commit=${parent}`, agentB, {}, env)).body.content as string;
    const twoArgs = pricing.includes('currency');
    const cart = `${CART}\nexport function shipping(): number {\n  return ${twoArgs ? "price(5, 'usd')" : 'price(5)'};\n}\n`;
    return (await api(`${repo}/commits`, agentB, { body: { parent, base_version: 1, changes: [file('src/cart.ts', cart)], message: 'Add shipping', author, read_set: declareReads ? ['src/pricing.ts'] : [] } }, env)).body.commit;
  };
  const runA = async () => {
    attempts++;
    return (await api(`${repo}/commits`, agentA, { body: { parent: base, base_version: 1, changes: [file('src/pricing.ts', PRICING_V2)], message: 'Price in currencies', author } }, env)).body.commit;
  };
  const land = (who: { token: string }, commit: string) => api(`${repo}/land`, who, { body: { ref: 'main', commit } }, env);
  const headOf = async () => (await api(`${repo}/log?ref=main&limit=1`, agentB, {}, env)).body.commits[0].commit as string;
  let conflicts = 0;
  let a: string;
  let b: string;
  if (scheduler === 'planned') {
    // The platform plans from the declared symbol sets; each stage starts on the head it finds.
    const items = [
      { id: 'shipping', read_set: ['src/pricing.ts#price'], write_set: ['src/cart.ts'] },
      { id: 'pricing', write_set: ['src/pricing.ts#price', 'src/pricing.ts#quote'] },
    ];
    const plan = (await api(`${repo}/plans`, owner, { body: { items } }, env)).body;
    expect(plan.stages.map((stage: number[]) => stage.flatMap((k) => plan.items[k].members))).toEqual([['pricing'], ['shipping']]);
    a = await runA();
    expect((await land(agentA, a)).body.landed).toBe(true);
    b = await runB(await headOf());
    expect((await land(agentB, b)).body.landed).toBe(true);
  } else {
    // Both start from the same base (scheduled in parallel: their files are disjoint).
    a = await runA();
    b = await runB(base);
    expect((await land(agentA, a)).body.landed).toBe(true);
    let landedB = await land(agentB, b);
    if (landedB.body.error?.code === 'CONFLICT') {
      conflicts++;
      b = await runB(await headOf());
      landedB = await land(agentB, b);
    }
    expect(landedB.body.landed).toBe(true);
  }
  // Main's Git head (reading it waits for the commit built for the landed work, whose
  // post-land combined check that projection requested), then every queued check runs.
  const head = (await api(`${repo}/log?ref=main&limit=1`, owner, {}, env)).body.commits[0].commit;
  for (const message of queued.splice(0).filter((m) => m.kind === 'platform_check')) await executeCheckRun(env, message);
  const headCheck = (await api(`${repo}/commits/${head}`, owner, {}, env)).body;
  const proposed = (await Promise.all([a, b, head].map((c) => api(`${repo}/commits/${c}`, owner, {}, env)))).flatMap((r) => r.body.repairs ?? []);
  return {
    scheduler: LABELS[scheduler],
    landed: 2,
    head_check: headCheck.checks.find((c: any) => c.name === 'combined')?.status ?? 'missing',
    stale_read_conflicts: conflicts,
    agent_attempts: attempts,
    repairs_proposed: proposed.filter((r: any) => r.repair_commit).length,
    accepted: headCheck.checks.find((c: any) => c.name === 'combined')?.status === 'pass' ? 2 : 0,
  };
}

it('file-disjoint scheduling breaks semantically; read sets turn it into a redo; plans avoid it', async () => {
  const disjoint = await scenario('disjointsched', 'disjoint');
  const aware = await scenario('awaresched', 'aware');
  const planned = await scenario('plannedsched', 'planned');
  console.log(`YONEDA_EVAL_P9 ${JSON.stringify({ manifest: { study: 'P9', agents: 'scripted-v1 (no model calls)', check: 'price() arity (combined, post-land)' }, results: [disjoint, aware, planned] })}`);
  expect(disjoint).toMatchObject({ head_check: 'fail', stale_read_conflicts: 0, accepted: 0 });
  expect(disjoint.repairs_proposed).toBeGreaterThan(0);
  expect(aware).toMatchObject({ head_check: 'pass', stale_read_conflicts: 1, accepted: 2, repairs_proposed: 0 });
  expect(aware.agent_attempts).toBe(disjoint.agent_attempts + 1);
  expect(planned).toMatchObject({ head_check: 'pass', stale_read_conflicts: 0, accepted: 2, repairs_proposed: 0 });
  expect(planned.agent_attempts).toBe(disjoint.agent_attempts);
}, 300_000);
