// Proof flows (plan wave 6, B10c and C13): stock CLIs in Cloudflare Sandboxes as load on the
// git platform, measured on fresh projects that are always deleted. Nothing here plans,
// coordinates or reviews agents: tasks are owner-written, the platform's server merge
// integrates a team, and the only grouping is the platform's own `git_plan` answer.
// - Fixtures are seeded by one sandbox run told to run one shell command (the bytes never
//   pass through a model); the kit compares every seeded file with the fixture before
//   publishing it as the project's main, and stops on any difference.
// - `tokens` (B10c, and C13 P2's symbol-level reads): the same task, CLI and model with and
//   without a paragraph naming the platform's read tools (`yoneda grep|symbols|blame|log`,
//   reachable from the sandbox through its existing read-only egress), both arms at once per
//   round on the same seeded base. It reports the Worker-metered tokens and spend per arm
//   and how often the CLI really called the tools.
// - `p9` (C13 P9): tasks on disjoint files where one calls what the other changes, run
//   (a) together in one team (a file-disjoint scheduler) and (b) in the stages `git_plan`
//   returns for the owner's declared read and write sets, each stage published before the
//   next; plus a dependency-disjoint control. The project's required check decides
//   landed-but-broken (`rejected`) against clean.
// Every flow stops starting runs once the metered spend reaches the cap ($0.50).
import {
  P9_INTENT,
  P9_POLICY,
  P9_SETS,
  P9_TASKS,
  TOKEN_ARMS,
  TOKEN_POLICY,
  armSummary,
  compareArms,
  estimate,
  fisherExact,
  p9Fixture,
  p9Outcome,
  planItems,
  seedBrief,
  seedCommand,
  seedMismatches,
  stagesFromPlan,
  sumUsage,
  tokenFixture,
  toolProfile,
} from './proof-fixtures.mjs';
import { bindManagedProviders, createProject, deleteProject, ensureAllowance, publish } from './project-flow.mjs';
import { activity, smokeAgents, startAgents, startTeam, waitChecked, waitPushed } from './sandbox-smoke.mjs';

export const SPEND_CAP_USD = 0.5;
const ARM_ORDER = ['tools', 'plain'];

/** Metered spend so far; refuses to start another run at or over the cap. */
class Spend {
  usd = 0;
  add(usage) {
    this.usd += usage?.usd ?? 0;
  }
  guard() {
    if (this.usd >= SPEND_CAP_USD) throw new Error(`Metered spend $${this.usd.toFixed(4)} reached the $${SPEND_CAP_USD} cap; no further runs started`);
  }
}

/** What a proof costs before it runs, and what it would send (no network, no credentials). */
export function proofPlan(kind, trials) {
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10) throw new Error('--trials is 1 to 10');
  if (kind === 'tokens') {
    const files = tokenFixture();
    return {
      kind,
      trials,
      estimate: estimate(1 + 2 * trials, 0.03, 4 + 4 * trials),
      fixture: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, c.split('\n').length])),
      seed_command_bytes: seedCommand(files).shell.length,
      arms: Object.fromEntries(ARM_ORDER.map((arm) => [arm, { label: TOKEN_ARMS[arm].label, brief_chars: TOKEN_ARMS[arm].brief.intent.length }])),
    };
  }
  if (kind === 'p9') {
    return {
      kind,
      trials,
      // Per trial: seed 1, file-disjoint team 2, control team 2, planned stages 1 + 1.
      estimate: estimate(7 * trials, 0.01, 14 * trials),
      fixture: Object.keys(p9Fixture()),
      plans: Object.fromEntries(Object.entries(P9_SETS).map(([set, ids]) => [set, { items: planItems(ids) }])),
    };
  }
  throw new Error(`Unknown proof ${kind}: tokens or p9`);
}

/** A run's outcome: its one candidate's check status and tree, metered usage, CLI tool use. */
async function settle(ctx, repo, runId, team) {
  let candidate = null;
  let status = null;
  let error = null;
  try {
    const { candidates } = await waitPushed(ctx.account, repo, runId, 1, ctx.timeoutMs, team);
    candidate = candidates[0];
    status = (await waitChecked(ctx.account, repo, runId, [candidate.id], ctx.checkWaitMs)).statuses[0];
  } catch (failure) {
    error = String(failure?.message ?? failure).slice(0, 300);
    await ctx.account.post(`/api/repos/${repo}/cancel_run`, { run_id: runId }).catch(() => {});
  }
  const detail = await ctx.account.get(`/api/repos/${repo}/runs/${runId}`);
  const usage = sumUsage(detail.executions);
  ctx.spend.add(usage);
  const profiles = [];
  for (const execution of detail.executions ?? []) profiles.push(toolProfile((await activity(ctx.account, repo, execution.id).catch(() => ({ entries: [] }))).entries));
  const profile = Object.fromEntries(['tool_calls', 'yoneda_calls', 'file_reads', 'searches'].map((k) => [k, profiles.reduce((s, p) => s + p[k], 0)]));
  const files = candidate ? ((await ctx.account.get(`/api/repos/${repo}/candidate_source?id=${encodeURIComponent(candidate.id)}`)).files ?? {}) : {};
  return { run: runId, candidate: candidate?.id ?? null, status, error, files, usage, profile };
}

/** Seeds `files` through one sandbox run, verifies every byte, and publishes it as main. */
async function seed(ctx, project, files) {
  ctx.spend.guard();
  const runId = await startAgents(ctx.account, project.id, ctx.models, ctx.cli, seedBrief(files));
  const out = await settle(ctx, project.id, runId, false);
  if (out.error) throw new Error(`Seed run ${runId}: ${out.error}`);
  const wrong = seedMismatches(files, out.files);
  if (wrong.length) throw new Error(`Seed run ${runId} wrote ${wrong.join(', ')} differently from the fixture`);
  if (out.status !== 'eligible') throw new Error(`Seed candidate was ${out.status ?? 'not checked in time'}`);
  await publish(ctx.account, project.id, null, {}, out.candidate);
  return out;
}

async function withProject(ctx, name, policy, work) {
  const project = await createProject(ctx.account, `${name}-${Date.now()}`, {}, policy);
  try {
    return await work(project);
  } finally {
    await deleteProject(ctx.account, project, {}).catch((e) => console.error(`Deleting ${project.id} failed: ${e.message}`));
  }
}

const usd = (x) => (x == null ? '-' : `$${x.toFixed(4)}`);
const num = (x) => (x == null ? '-' : Math.round(x).toString());
const line = (label, s, fmt = num) => `  ${label}: n=${s.n} mean ${fmt(s.mean)} sd ${fmt(s.sd)} range ${fmt(s.min)}-${fmt(s.max)}${s.note ? ` (${s.note})` : ''}`;

/** B10c / C13 P2: `trials` rounds, each running both arms at once on the seeded base. */
export async function tokenProof(ctx, metrics) {
  const samples = { tools: [], plain: [] };
  await withProject(ctx, 'proof-tokens', TOKEN_POLICY, async (project) => {
    const seeded = await seed(ctx, project, tokenFixture());
    metrics.seed_usd = seeded.usage.usd.toFixed(4);
    for (let round = 0; round < ctx.trials; round++) {
      ctx.spend.guard();
      const runs = await Promise.all(ARM_ORDER.map((arm) => startAgents(ctx.account, project.id, ctx.models, ctx.cli, TOKEN_ARMS[arm].brief)));
      const outs = await Promise.all(runs.map((run) => settle(ctx, project.id, run, false)));
      ARM_ORDER.forEach((arm, i) => {
        const out = outs[i];
        const done = out.status === 'eligible' && /\binvoiceTotalWithTax\b/.test(out.files['src/billing.js']?.content ?? '');
        samples[arm].push({ round, run: out.run, status: out.status, error: out.error, done, ...out.usage, ...out.profile });
      });
    }
  });
  const report = [`Token proof (${ctx.model}, ${ctx.cli ?? 'claude'} CLI; ${ctx.trials} rounds, both arms per round):`];
  for (const arm of ARM_ORDER) {
    const rows = samples[arm];
    const pick = (k) => armSummary(rows.map((r) => r[k]));
    report.push(`${TOKEN_ARMS[arm].label}: ${rows.filter((r) => r.done).length}/${rows.length} done`, line('input tokens', pick('input')), line('output tokens', pick('output')), line('metered spend', pick('usd'), usd), line('yoneda tool calls', pick('yoneda_calls')), line('whole-file reads', pick('file_reads')));
    Object.assign(metrics, { [`${arm}_n`]: rows.length, [`${arm}_done`]: rows.filter((r) => r.done).length, [`${arm}_in_mean`]: num(pick('input').mean), [`${arm}_out_mean`]: num(pick('output').mean), [`${arm}_usd_mean`]: pick('usd').mean?.toFixed(4), [`${arm}_yoneda_calls`]: rows.reduce((s, r) => s + r.yoneda_calls, 0) });
  }
  const input = compareArms(samples.tools.map((r) => r.input), samples.plain.map((r) => r.input));
  report.push(`tools/plain input-token ratio ${input.ratio?.toFixed(2) ?? '-'}: ${input.claim}`);
  Object.assign(metrics, { input_ratio: input.ratio?.toFixed(2), claim: input.claim, samples });
  console.log(report.join('\n'));
  if (samples.tools.every((r) => r.yoneda_calls === 0)) console.log('Note: the tools arm never called a yoneda read tool; the arms then differ only by the prompt paragraph.');
}

/** One owner-written team run of `ids` on the project's current main. */
async function teamRun(ctx, repo, ids) {
  ctx.spend.guard();
  const tasks = ids.map((id) => [id, P9_TASKS[id].title, P9_TASKS[id].instructions]);
  const runId = await startTeam(ctx.account, repo, ctx.models[0], { ...P9_INTENT, tasks }, ctx.cli);
  return settle(ctx, repo, runId, true);
}

/** The platform's stages run in order; every stage but the last is published before the next. */
async function staged(ctx, repo, stages) {
  const runs = [];
  for (const [i, stage] of stages.entries()) {
    const out = await teamRun(ctx, repo, stage);
    runs.push(out);
    const last = i === stages.length - 1;
    if (out.error || last || out.status !== 'eligible') return { runs, out, stage: i };
    await publish(ctx.account, repo, null, {}, out.candidate);
  }
  return { runs, out: null, stage: -1 };
}

const ARMS_P9 = {
  'file-disjoint (coupled)': 'Both coupled tasks in one team, on the same base',
  'planned (coupled)': 'Coupled tasks in git_plan stages, each published before the next',
  'planned (control)': 'Dependency-disjoint tasks in git_plan stages',
};

/** C13 P9: `trials` fresh projects, each with all three arms. */
export async function p9Proof(ctx, metrics) {
  const results = Object.fromEntries(Object.keys(ARMS_P9).map((arm) => [arm, []]));
  const plans = [];
  const record = (arm, outcome, runs) =>
    results[arm].push({ outcome, runs: runs.map((r) => ({ run: r.run, status: r.status, error: r.error })), usd: runs.reduce((s, r) => s + r.usage.usd, 0) });
  for (let trial = 0; trial < ctx.trials; trial++) {
    await withProject(ctx, 'proof-p9', P9_POLICY, async (project) => {
      await seed(ctx, project, p9Fixture());
      const plan = async (ids) => stagesFromPlan(await ctx.account.post(`/api/v1/repos/${project.platform.repo}/plans`, { items: planItems(ids) }));
      const [coupled, control] = [await plan(P9_SETS.coupled), await plan(P9_SETS.control)];
      plans.push({ coupled, control });
      // The control arm is the plan's single stage; a staged control would move main under the planned arm.
      if (control.length !== 1) throw new Error(`git_plan staged the dependency-disjoint control: ${JSON.stringify(control)}`);
      const [together, alone] = await Promise.all([teamRun(ctx, project.id, P9_SETS.coupled), teamRun(ctx, project.id, control[0])]);
      record('file-disjoint (coupled)', together.error ? 'failed' : p9Outcome(together.status, together.files, P9_SETS.coupled), [together]);
      record('planned (control)', alone.error ? 'failed' : p9Outcome(alone.status, alone.files, control[0]), [alone]);
      const planned = await staged(ctx, project.id, coupled);
      const last = planned.out;
      const outcome = last?.error ? 'failed' : planned.stage === coupled.length - 1 ? p9Outcome(last.status, last.files, P9_SETS.coupled) : last?.status === 'rejected' ? 'broken' : 'unsettled';
      record('planned (coupled)', outcome, planned.runs);
    }).catch((failure) => {
      metrics[`trial_${trial}_error`] = String(failure?.message ?? failure).slice(0, 300);
    });
    if (ctx.spend.usd >= SPEND_CAP_USD) break;
  }
  const count = (arm, outcome) => results[arm].filter((r) => r.outcome === outcome).length;
  const report = [`P9 proof (${ctx.model}, ${ctx.cli ?? 'claude'} CLI; ${ctx.trials} trials; plans: ${JSON.stringify(plans[0] ?? null)}):`];
  for (const [arm, label] of Object.entries(ARMS_P9)) {
    const n = results[arm].length;
    const tally = ['clean', 'broken', 'incomplete', 'unsettled', 'failed'].map((o) => `${o} ${count(arm, o)}`).join(', ');
    report.push(`${arm} [${label}]: n=${n}: ${tally}${n < 3 ? ' (n<3: no claim)' : ''}`);
    metrics[arm.replace(/\W+/g, '_').replace(/_$/, '')] = `n=${n} ${tally}`;
  }
  const [a, b] = ['file-disjoint (coupled)', 'planned (coupled)'];
  const [na, nb] = [results[a].length, results[b].length];
  const p = fisherExact(count(a, 'broken'), na - count(a, 'broken'), count(b, 'broken'), nb - count(b, 'broken'));
  report.push(`broken, file-disjoint vs planned: Fisher exact two-sided p=${p.toFixed(3)}${na < 3 || nb < 3 ? ' (n<3 in an arm: no claim)' : ''}`);
  Object.assign(metrics, { fisher_p: p.toFixed(3), results, plans });
  console.log(report.join('\n'));
}

/** Runs one proof on the kit account: managed cheap models, the $5 allowance, the spend cap. */
export async function proof({ kind, account, owner, username, provider, cli = null, trials = 3, timeoutMs = 900_000, checkWaitMs = 300_000 }, metrics) {
  // As in the sandbox smoke: MiMo Code runs the MiMo model unless told otherwise.
  provider ??= cli === 'mimo' ? 'mimo' : 'zai';
  const plan = proofPlan(kind, trials);
  console.log(`Estimate: ${plan.estimate.executions} agent executions, about $${plan.estimate.usd} and ${plan.estimate.minutes} min; runs stop at $${SPEND_CAP_USD} metered.`);
  await bindManagedProviders(owner, username);
  await ensureAllowance(account, owner, username);
  const models = await smokeAgents(account, provider, 1, cli);
  const ctx = { account, models, cli, trials, timeoutMs, checkWaitMs, spend: new Spend(), model: `${models[0].provider}/${models[0].model}` };
  Object.assign(metrics, { proof: kind, model: ctx.model, cli: cli ?? 'claude', trials, estimate_usd: plan.estimate.usd });
  try {
    await (kind === 'tokens' ? tokenProof : p9Proof)(ctx, metrics);
  } finally {
    metrics.spend_usd = ctx.spend.usd.toFixed(4);
  }
}
