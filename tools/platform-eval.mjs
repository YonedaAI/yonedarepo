#!/usr/bin/env node
// N9 evaluation runner: Study A (layouts x interfaces, retrieval faults) and the P9
// scheduling demo, run in workerd against the real platform. Agents are scripted
// (deterministic, no model calls); results are labeled simulated. Writes
// .local/platform-eval/report.json and report.md with a reproducible manifest.
import { execFileSync, spawnSync } from 'node:child_process';
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
const marker = (name) => {
  const line = run.stdout.split('\n').find((l) => l.includes(`${name} `));
  return line ? JSON.parse(line.slice(line.indexOf(`${name} `) + name.length + 1)) : null;
};
const studyA = marker('YONEDA_EVAL_STUDY_A');
const p9 = marker('YONEDA_EVAL_P9');
const report = {
  schema: 1,
  passed: run.status === 0 && !!studyA && !!p9,
  recorded_at: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  label: 'SIMULATED: scripted deterministic agents, no model calls; cost units are (bytes read + written) / 4',
  model_arms: 'not run (need a provider budget and the owner\'s go-ahead)',
  study_a: studyA,
  p9,
};
const pct = (x) => (typeof x === 'number' ? `${(x * 100).toFixed(0)}%` : x);
const rows = (studyA?.arms ?? []).concat(studyA?.faulted ? [{ ...studyA.faulted, layout: `${studyA.faulted.layout} (30% search faults)` }] : []);
const markdown = [
  '# Platform evaluation (simulated)',
  '',
  `${report.label}. Model-driven arms: ${report.model_arms}. Revision ${report.revision}.`,
  '',
  '## Study A: layouts x interfaces',
  '',
  '| Layout | Interface | Accepted | Closure recall | Exposure precision | Cost per accepted |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.layout} | ${r.interface} | ${r.accepted}/${r.tasks} | ${pct(r.closure_recall)} | ${pct(r.exposure_precision)} | ${r.cost_per_accepted} |`),
  '',
  '## P9: scheduling with a semantic dependency',
  '',
  '| Scheduler | Combined check | Accepted | Stale-read conflicts | Agent attempts | Repairs proposed |',
  '|---|---|---|---|---|---|',
  ...(p9?.results ?? []).map((r) => `| ${r.scheduler} | ${r.head_check} | ${r.accepted}/${r.landed} | ${r.stale_read_conflicts} | ${r.agent_attempts} | ${r.repairs_proposed} |`),
  '',
].join('\n');
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(output, 'report.md'), markdown);
console.log(markdown);
process.exit(report.passed ? 0 : 1);
