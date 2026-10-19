// N9 P9 demo: two tasks on disjoint files with a semantic dependency. A changes price()'s
// signature (and its own callers); B adds a new price() call in another file. Each passes
// alone. File-disjoint scheduling lands both and only the post-land combined check sees
// the break; dependency-aware scheduling (B declares what it read) turns it into a stale-
// read conflict that B redoes on the new head. Scripted agents; no model calls.
import { expect, it } from 'vitest';
import { executeCheckRun } from '../../cloudflare/worker/repo-checks';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

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
  return { outcome: ok ? 'pass' : 'fail', exit_code: ok ? 0 : 1, timed_out: false, duration_ms: 1, output_bytes: 0, output_sha256: '0'.repeat(64), output_tail: ok ? '' : 'price() arity mismatch\n' };
}
const env = { ...scoped, CHECK_RUNNERS: { idFromName: (n: string) => n, get: () => ({ run: async (job: any) => arityCheck(job) }) } } as unknown as Env;

async function scenario(name: string, declareReads: boolean) {
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
  // Both start from the same base (scheduled in parallel: their files are disjoint).
  attempts++;
  const a = (await api(`${repo}/commits`, agentA, { body: { parent: base, base_version: 1, changes: [file('src/pricing.ts', PRICING_V2)], message: 'Price in currencies', author } }, env)).body.commit;
  let b = await runB(base);
  expect((await api(`${repo}/land`, agentA, { body: { ref: 'main', commit: a } }, env)).body.landed).toBe(true);
  let landedB = await api(`${repo}/land`, agentB, { body: { ref: 'main', commit: b } }, env);
  let conflicts = 0;
  if (landedB.body.error?.code === 'CONFLICT') {
    conflicts++;
    const head = (await api(`${repo}/log?ref=main&limit=1`, agentB, {}, env)).body.commits[0].commit;
    b = await runB(head);
    landedB = await api(`${repo}/land`, agentB, { body: { ref: 'main', commit: b } }, env);
  }
  expect(landedB.body.landed).toBe(true);
  // Post-land combined checks on everything that landed.
  for (const message of queued.splice(0).filter((m) => m.kind === 'platform_check')) await executeCheckRun(env, message);
  const head = (await api(`${repo}/log?ref=main&limit=1`, owner, {}, env)).body.commits[0].commit;
  const headCheck = (await api(`${repo}/commits/${head}`, owner, {}, env)).body;
  const proposed = (await Promise.all([a, b, head].map((c) => api(`${repo}/commits/${c}`, owner, {}, env)))).flatMap((r) => r.body.repairs ?? []);
  return {
    scheduler: declareReads ? 'dependency-aware (read sets)' : 'file-disjoint',
    landed: 2,
    head_check: headCheck.checks.find((c: any) => c.name === 'combined')?.status ?? 'missing',
    stale_read_conflicts: conflicts,
    agent_attempts: attempts,
    repairs_proposed: proposed.filter((r: any) => r.repair_commit).length,
    accepted: headCheck.checks.find((c: any) => c.name === 'combined')?.status === 'pass' ? 2 : 0,
  };
}

it('file-disjoint scheduling breaks semantically; read sets turn it into a redo', async () => {
  const disjoint = await scenario('disjointsched', false);
  const aware = await scenario('awaresched', true);
  console.log(`YONEDA_EVAL_P9 ${JSON.stringify({ manifest: { study: 'P9', agents: 'scripted-v1 (no model calls)', check: 'price() arity (combined, post-land)' }, results: [disjoint, aware] })}`);
  expect(disjoint).toMatchObject({ head_check: 'fail', stale_read_conflicts: 0, accepted: 0 });
  expect(disjoint.repairs_proposed).toBeGreaterThan(0);
  expect(aware).toMatchObject({ head_check: 'pass', stale_read_conflicts: 1, accepted: 2, repairs_proposed: 0 });
  expect(aware.agent_attempts).toBe(disjoint.agent_attempts + 1);
}, 300_000);
