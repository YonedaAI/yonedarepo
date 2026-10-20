#!/usr/bin/env node
// N9 evaluation runner: Study A (layouts x interfaces, retrieval faults) and the P9
// scheduling demo, run in workerd against the real platform with scripted agents
// (deterministic, no model calls; labeled SIMULATED), plus the eval Worker's local suite
// (fake model endpoints). Real-model arms come from the separate paid command
// tools/platform-eval-models.mjs; their saved results (model-arms-{full,p9}-*.json) are merged
// side by side, each row labeled with model, provider, route and date. Writes
// .local/platform-eval/report.json and report.md with a reproducible manifest.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.local/platform-eval');
const build = spawnSync('worker-build', ['--release'], { cwd: resolve(root, 'backend/crates/yoneda-worker'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`Wasm build failed:\n${build.stderr}`);
const run = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'tests/workers/vitest.config.ts', 'tests/workers/eval-study.test.ts', 'tests/workers/eval-scheduling.test.ts', '--reporter=verbose'],
  { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 64 * 1024 * 1024 },
);
const evalWorker = spawnSync('npx', ['vitest', 'run', '--config', 'tests/eval-worker/vitest.config.ts'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' },
});
const marker = (name) => {
  const line = run.stdout.split('\n').find((l) => l.includes(`${name} `));
  return line ? JSON.parse(line.slice(line.indexOf(`${name} `) + name.length + 1)) : null;
};
const studyA = marker('YONEDA_EVAL_STUDY_A');
const p9 = marker('YONEDA_EVAL_P9');
await mkdir(output, { recursive: true, mode: 0o700 });
// Per-run spend is summed from the run's own requests: parallel runs share one ledger.
const spentBy = (r) =>
  r.smoke.reduce((sum, s) => sum + s.usage.microusd / 1e6, 0) +
  [...r.arms, ...r.p9].reduce((sum, a) => sum + a.usage.usd, 0);
const saved = readdirSync(output, { withFileTypes: true })
  .filter((f) => /^model-arms-(full|p9)-.+\.json$/.test(f.name))
  .map((f) => JSON.parse(readFileSync(resolve(output, f.name), 'utf8')));
const modelArms = saved.length
  ? {
      runs: saved.map((r) => ({ run: r.run, started_at: r.started_at, total_usd: Number(spentBy(r).toFixed(6)), smoke: r.smoke.map(({ provider, model, route, ok, error }) => ({ provider, model, route, ok, error })), skipped: r.skipped, p9_preflight: r.p9_preflight?.verdicts, manifest: r.manifest })),
      total_usd: Number(saved.reduce((sum, r) => sum + spentBy(r), 0).toFixed(6)),
      ledger_settled_usd: Math.max(...saved.map((r) => r.spend_after.settled_microusd)) / 1e6,
      arms: saved.flatMap((r) => r.arms.map(({ attempts, limits, ...arm }) => arm)),
      p9: saved.flatMap((r) => r.p9.map(({ attempts, landings, limits, ...result }) => result)),
    }
  : 'not run (tools/platform-eval-models.mjs is the separate paid command)';
const report = {
  schema: 2,
  passed: run.status === 0 && evalWorker.status === 0 && !!studyA && !!p9,
  eval_worker_suite: evalWorker.status === 0 ? 'passed' : `failed:\n${evalWorker.stdout.slice(-2000)}`,
  recorded_at: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  label: 'SIMULATED: scripted deterministic agents, no model calls; cost units are (bytes read + written) / 4',
  model_arms: modelArms,
  study_a: studyA,
  p9,
};
const pct = (x) => (typeof x === 'number' ? `${(x * 100).toFixed(0)}%` : (x ?? 'n/a'));
const SIM = 'SIMULATED scripted-v1';
const real = (r) => `REAL ${r.model} (${r.provider}, ${r.route})`;
const usd = (x) => (typeof x === 'number' ? `$${x.toFixed(4)}` : x);
const failures = (u) => (u ? Object.entries(u.failures).map(([k, v]) => `${k} ${v}`).join(', ') : 'n/a');
const scripted = (studyA?.arms ?? []).concat(studyA?.faulted ? [{ ...studyA.faulted, drop_rate: 0.3 }] : []);
const models = typeof modelArms === 'object' ? modelArms : null;
const studyRows = [
  ...scripted.map((r) => [SIM, r, `${r.cost_per_accepted} units`, 'n/a']),
  ...(models?.arms ?? []).filter((r) => r.tasks_planned === 6).map((r) => [real(r), r, usd(r.usd_per_accepted), failures(r.usage)]),
];
const markdown = [
  '# Platform evaluation',
  '',
  `Revision ${report.revision}. Scripted rows: ${report.label}. Real-model rows: ${models ? `${models.arms.length} arms and ${models.p9.length} P9 runs, total $${models.total_usd} metered-equivalent of the $5 cap (${models.runs.map((r) => r.run).join(', ')})` : modelArms}.`,
  '',
  '## Study A: layouts x interfaces',
  '',
  '| Agent | Layout | Interface | Faults | Accepted | Closure recall | Exposure precision | Edit expansion | Cost per accepted | Model failures |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...studyRows.map(([agent, r, cost, fail]) => `| ${agent} | ${r.layout} | ${r.interface} | ${r.drop_rate ? `${r.drop_rate * 100}% search` : 'none'} | ${r.accepted}/${r.tasks}${r.stopped ? ` (stopped: ${r.stopped})` : ''} | ${pct(r.closure_recall)} | ${pct(r.exposure_precision)} | ${r.edit_expansion ?? 'n/a'} | ${cost} | ${fail} |`),
  '',
  '## P9: scheduling with a semantic dependency',
  '',
  '| Agent | Scheduler | Combined check | Accepted | Stale-read conflicts | Agent attempts | Repairs proposed | Cost per accepted |',
  '|---|---|---|---|---|---|---|---|',
  ...(p9?.results ?? []).map((r) => `| ${SIM} | ${r.scheduler} | ${r.head_check} | ${r.accepted}/${r.landed} | ${r.stale_read_conflicts} | ${r.agent_attempts} | ${r.repairs_proposed} | n/a |`),
  ...(models?.p9 ?? []).map((r) => `| ${real(r)} | ${r.scheduler} | ${r.head_check} | ${r.accepted}/2 (${r.landed} landed) | ${r.stale_read_conflicts} | ${r.agent_attempts} | ${r.repairs_proposed} | ${usd(r.usd_per_accepted)} |`),
  '',
].join('\n');
await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(output, 'report.md'), markdown);
console.log(markdown);
process.exit(report.passed ? 0 : 1);
