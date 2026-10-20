// N9 Study A (small scale): 3 layouts x 2 interfaces with scripted agents (no models),
// plus a retrieval-fault arm. Measures closure recall, exposure precision and cost per
// accepted change at the API boundary; an independent oracle decides acceptance.
import { expect, it } from 'vitest';
import { AGENTS, type Api, type ArmResult, codebase, judge, LAYOUTS, newReceipt, render, type Run, score, searchFaults, tasks } from '../eval/study';
import { api as call, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const SEED = 20261019;

async function arm(owner: { cookie: string }, layout: (typeof LAYOUTS)[number], iface: string, dropRate = 0): Promise<ArmResult> {
  const symbols = codebase(SEED);
  const created = await call('/repos', owner, {
    body: { name: `${layout}-${iface}`, policy: { required_checks: [], approvals: 0 }, files: render(layout, symbols).map(([p, t]) => file(p, t)), author },
  });
  const repo = `/repos/${created.body.id}`;
  const token = (await call(`${repo}/tokens`, owner, { body: { name: 'agent', scopes: ['read', 'write', 'land'] } })).body.token;
  const api: Api = (path, init) => call(`${repo}${path}`, { token }, init);
  const runs: Run[] = [];
  const faults = searchFaults(SEED, dropRate);
  for (const task of tasks(symbols, 6, SEED)) {
    const receipt = newReceipt();
    const commit = await AGENTS[iface](api, task, symbols, receipt, faults);
    const landed = commit ? (await api('/land', { body: { ref: 'main', commit } })).body.landed === true : false;
    // Independent oracle: the target now adds one, and nothing else changed.
    const verdict = landed ? judge((await call(`${repo}/diff?head=${commit}&patch=1`, owner)).body, task, symbols) : { accepted: false };
    runs.push({ task, receipt, ...verdict });
  }
  return score(layout, iface, runs, symbols);
}

it('measures what file and symbol interfaces expose across layouts', async () => {
  const owner = { cookie: await signup('evaluator') };
  const arms: ArmResult[] = [];
  for (const layout of LAYOUTS) for (const iface of ['file', 'symbol']) arms.push(await arm(owner, layout, iface));
  const faulted = await arm(owner, 'modules', 'symbol', 0.3);
  const blind = await arm(owner, 'modules', 'file', 1);
  const manifest = { study: 'A', seed: SEED, agents: 'scripted-v1 (deterministic, no model calls)', models: 'none', cost_units: '(bytes read + written) / 4, simulated' };
  console.log(`YONEDA_EVAL_STUDY_A ${JSON.stringify({ manifest, arms, faulted })}`);

  for (const result of arms) expect(result.closure_recall, `${result.layout}/${result.interface}`).toBe(1);
  for (const result of arms) expect(result.accepted, `${result.layout}/${result.interface}`).toBe(result.tasks);
  for (const result of arms) expect(result.edit_expansion, `${result.layout}/${result.interface}`).toBe(1);
  const of = (layout: string, iface: string) => arms.find((a) => a.layout === layout && a.interface === iface)!;
  for (const layout of LAYOUTS) expect(of(layout, 'symbol').exposure_precision).toBeGreaterThan(of(layout, 'file').exposure_precision);
  // P2: symbol-aware access decouples exposure from layout; whole-file reads do not.
  const symbolPrecision = LAYOUTS.map((l) => of(l, 'symbol').exposure_precision);
  expect(Math.max(...symbolPrecision) - Math.min(...symbolPrecision)).toBeLessThan(0.15);
  expect(of('monolith', 'file').exposure_precision).toBeLessThan(of('symbol-files', 'file').exposure_precision);
  // Retrieval faults lower closure recall; failures stay in the cost denominator.
  expect(faulted.search_faults).toBeGreaterThan(0);
  expect(faulted.closure_recall).toBeLessThan(1);
  // An arm that accepts nothing has no finite cost per accepted change.
  expect(blind).toMatchObject({ accepted: 0, cost_per_accepted: 'not finitely estimated' });
}, 300_000);
