// The memory test (`--memory-test`, stage 2 of docs/landings-plan.md, dev only, real agents, the
// model's quota): does an agent do better with YonedaRepo's memory and context than with a
// plain clone? Two arms on the Docker sandbox (agent-sandbox.mjs), `plain` (stock Git, no
// plugin, nothing on its fork) and `memory` (the yoneda plugin, with a trap's memories on its
// fork), the same prompt but for one tool paragraph, in blocks of one run per arm so both
// meet the same provider. Every run gets its own fresh fork of a real-history repository,
// since memories can't be deleted and forks copy none (memory-traps.mjs: the traps and how
// delivery is kept realistic; memory-run.mjs: one run). The owner's account forks `oss-cobra`,
// `oss-commander` and `oss-click`; every ref of those parents must be as it was at the end.
// Forks are deleted after their block, on any failure, on Ctrl-C and, for one left by a killed
// process, when the next run starts. The host checkouts and remotes are snapshotted around it
// all, as for kit item 29. It prints its estimate and starts only with --yes. Evidence:
// .local/staging/memory-test-<ts>/ (one timestamped JSON per run, the commands, events and hook
// logs) and the summary .local/staging/memory-test-<ts>.json, rewritten after each block; a real
// run also fills the results section of docs/landings-plan.md.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { hostProblems, runAgent, spendBudget } from './agent-run-flow.mjs';
import { egressAllowlist, sandboxOrigin } from './agent-sandbox.mjs';
import { buildSandbox, dockerAvailable, hostState, modelCredential, startEgress } from './agent-sandbox-host.mjs';
import { Session } from './client.mjs';
import { ARMS, DEFAULT_RUNS, isTestFork, planText, schedule } from './memory-plan.mjs';
import { deleteFork, freshRefs, judgeRun, prepareRun } from './memory-run.mjs';
import { TRAPS } from './memory-traps.mjs';
import { fillResults, resultsMarkdown, verdict } from './memory-verdict.mjs';
import { Workspace } from './realuser-git.mjs';
import { ownerLogin } from './realuser-flow.mjs';
import { pickRepo, scrubber } from './realuser-plan.mjs';

/** Revokes the agents' tokens and deletes forks `ids`, keeping what could not be undone;
 * returns those problems. */
async function dropForks(ctx, ids) {
  const problems = [];
  for (const id of ctx.tokens) {
    const done = await ctx.owner.raw('DELETE', `/tokens/${id}`).catch((e) => ({ status: e.message }));
    if (done.ok || done.status === 404) ctx.tokens.delete(id);
    else problems.push(`token ${id} not revoked: ${done.status}`);
  }
  for (const id of ids) {
    const name = ctx.forks.get(id);
    try {
      ctx.deleted.push({ id, name, read_after: await deleteFork(ctx.owner, id, name) });
      ctx.forks.delete(id);
    } catch (e) {
      problems.push(`${name}: ${ctx.ws.scrub(e.message)}`);
    }
  }
  return problems;
}

/** Forks an earlier run left (a killed process runs no cleanup); only this test's names. */
async function sweepStale(ctx) {
  for (const repo of (await ctx.owner.get('/repos')).repos.filter((r) => isTestFork(r.name))) {
    await deleteFork(ctx.owner, repo.id, repo.name);
    ctx.swept.push(repo.name);
  }
}

function writeSummary(ctx, extra = {}) {
  const { records, file, ws, model, ts, started } = ctx;
  const body = { schema: 1, ts, started, model, arms: ARMS, traps: TRAPS.map((t) => ({ id: t.id, repo: t.repo, rule: t.rule })), verdict: verdict(records), records: records.map(({ usage, ...rest }) => rest), errors: ctx.errors, forks_deleted: ctx.deleted, forks_swept: ctx.swept, ...extra };
  writeFileSync(file, `${ws.scrub(JSON.stringify(body, null, 2))}\n`);
  return body;
}

/** One block: both arms' runs at once, then each judged, then their forks deleted. A setup
 * failure stops the whole test (it would repeat); a failed judgement costs that run. */
async function runBlock(ctx, { trap, round }) {
  const runs = [];
  try {
    for (const arm of ARMS) runs.push(await prepareRun(ctx, { trap, arm, round, parent: ctx.parents.get(trap.repo).id }));
    const outcomes = await Promise.all(runs.map((r) => runAgent(r.job)));
    for (const [i, run] of runs.entries())
      try {
        const record = await judgeRun(ctx, run, outcomes[i]);
        ctx.records.push(record);
        console.log(`  ${run.agent}: ${record.oracle.outcome}, ${record.tokens} tokens, ${Math.round(record.ms / 1000)} s${record.valid ? '' : `, INVALID: ${record.problems.join('; ')}`}`);
      } catch (e) {
        ctx.errors.push(`${run.agent}: ${ctx.ws.scrub(e.message)}`);
      }
  } catch (e) {
    ctx.errors.push(`${trap.id} round ${round}: ${ctx.ws.scrub(e.message)}`);
    ctx.budget.abort();
  } finally {
    ctx.errors.push(...(await dropForks(ctx, runs.map((r) => r.fork.id))));
    writeSummary(ctx);
  }
}

/**
 * Runs the test. `base`: `{ owner, ws, root, ts, secrets }` (the owner's cookie session on
 * /api/v1, a Workspace on the platform API); `options`: `{ runs, parallel, model, timeoutS,
 * budgetUsd, fake }`, the budget over what opencode reports, which on the coding plan is $0, so
 * there only the time limit caps a run. `fake` is the dry run: the scripted agent, no model, and no change to the plan doc.
 * Returns the summary.
 */
export async function memoryRun(base, { runs, parallel = 1, model, timeoutS, budgetUsd = 2, fake = false }) {
  const { owner, ws, root, ts, secrets } = base;
  const blocks = schedule(runs, TRAPS);
  assert.ok(dockerAvailable(), 'Docker is not available, and agents run only in the sandbox');
  assert.ok(existsSync(join(ws.bin, 'git-remote-yoneda')), `no git-remote-yoneda in ${ws.bin} (cargo build -p yoneda-cli --release)`);
  const credential = fake ? null : await modelCredential(model, ws.dir);
  if (credential) for (const entry of JSON.parse(credential)) for (const v of [entry.value?.key, entry.value?.access]) if (v) secrets.add(v);
  const sandbox = await buildSandbox(root);
  const evidence = resolve(root, `.local/staging/memory-test-${ts}`);
  mkdirSync(evidence, { recursive: true });
  const { origin } = sandboxOrigin(ws.api);
  const allow = egressAllowlist({ origin, model: fake ? null : model });
  const watched = [root, process.cwd(), process.env.PWD];
  const before = await hostState(watched);
  const budget = spendBudget(budgetUsd);
  const ctx = { ...base, origin, evidence, credential, model, image: sandbox.image, budget, timeoutS, fake, forks: new Map(), tokens: new Set(), containers: [], scanned: new Map(), parents: new Map(), records: [], errors: [], deleted: [], swept: [], file: resolve(root, `.local/staging/memory-test-${ts}.json`), started: new Date().toISOString() };
  const stop = () => {
    ctx.errors.push('interrupted');
    budget.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const repos = (await owner.get('/repos')).repos;
  const was = new Map();
  for (const trap of TRAPS) {
    const parent = pickRepo(repos, trap.repo);
    ctx.parents.set(trap.repo, parent);
    was.set(parent.id, JSON.stringify(await freshRefs(owner, parent.id)));
  }
  await sweepStale(ctx);
  ctx.egress = await startEgress({ image: sandbox.image, allow, run: `m${ts}` });
  try {
    const queue = [...blocks];
    const worker = async () => {
      while (queue.length && !budget.aborted) await runBlock(ctx, queue.shift());
    };
    await Promise.all(Array.from({ length: parallel }, worker));
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    for (const name of ctx.containers) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    const stopped = await ctx.egress.stop();
    ctx.errors.push(...(await dropForks(ctx, [...ctx.forks.keys()])));
    for (const [id, refs] of was) {
      const now = await freshRefs(owner, id).catch((e) => ctx.errors.push(`reading parent ${id}: ${e.message}`));
      if (now && JSON.stringify(now) !== refs) ctx.errors.push(`PARENT CHANGED: ${id}: was ${refs}, now ${JSON.stringify(now)}`);
    }
    const drift = await hostProblems(before, watched);
    if (drift.length) console.error(`\n!!! HOST CHANGED DURING THE MEMORY TEST !!!\n${drift.map((d) => `  - ${d}`).join('\n')}\n`);
    ctx.summary = writeSummary(ctx, { egress_allow: allow, egress_refused: [...new Set(stopped.refused)], egress_died: stopped.died, host_drift: drift, forks_left: [...ctx.forks.values()], tokens_left: [...ctx.tokens], opencode: fake ? 'scripted (fake-memory-agent)' : sandbox.opencode, sandbox: sandbox.image.slice(0, 19), finished: new Date().toISOString() });
  }
  return { ...ctx.summary, file: ctx.file, evidence };
}

/** Prints the answer; a real run also fills the plan's results section. Returns the exit code. */
export function report(summary, { root, fill }) {
  const v = summary.verdict;
  console.log(`\n${v.answer}\nTrap avoided: memory ${v.avoided.memory.yes}/${v.avoided.memory.n}, plain ${v.avoided.plain.yes}/${v.avoided.plain.n}, Fisher p = ${v.fisher_p.toFixed(4)}`);
  for (const line of summary.errors) console.error(`  ! ${line}`);
  console.log(`Evidence: ${summary.file}`);
  const trouble = summary.errors.length > 0 || summary.host_drift.length > 0 || summary.forks_left.length > 0 || summary.tokens_left.length > 0;
  if (fill && v.avoided.memory.n && v.avoided.plain.n) {
    const doc = join(root, 'docs/landings-plan.md');
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(doc, fillResults(readFileSync(doc, 'utf8'), resultsMarkdown(v, { recorded_at: summary.finished, model: summary.model, evidence: relative(root, summary.file), commit })));
    console.log(`Results written to ${doc}`);
  }
  return trouble || v.answer.startsWith('no answer') ? 1 : 0;
}

/** `--memory-test`: the estimate, then with --yes the owner's sign-in and the run. */
export async function memoryTest(values, root) {
  const runs = Number(values['memory-runs'] ?? DEFAULT_RUNS);
  const parallel = Number(values['memory-parallel'] ?? 1);
  const timeoutS = Number(values['agent-timeout']);
  const model = values['agent-model'];
  schedule(runs, TRAPS);
  assert.ok(Number.isInteger(parallel) && parallel >= 1, '--memory-parallel is a block count of at least 1');
  console.log(planText({ runs, parallel, timeoutS, model, traps: TRAPS }));
  if (!values.yes) {
    console.log('\nNothing started. Add --yes to run it.');
    return 0;
  }
  const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = process.env;
  assert.ok(username && password, 'set DEV_OWNER_USERNAME and DEV_OWNER_PASSWORD (set -a; . ~/.config/yonedarepo/dev-owner.env; set +a)');
  const ts = String(Date.now());
  const secrets = new Set([password]);
  const scrub = scrubber(secrets);
  const cookie = await ownerLogin(values.origin, username, password);
  secrets.add(cookie.split('=').slice(1).join('='));
  const owner = new Session(`${values.origin}/api/v1`, { cookie });
  const ws = new Workspace({ api: values.api, bin: values['cli-bin'] ?? resolve(root, 'target/release'), scrub });
  try {
    return report(await memoryRun({ owner, ws, root, ts, secrets }, { runs, parallel, model, timeoutS, budgetUsd: Number(values['agent-budget']) }), { root, fill: true });
  } finally {
    ws.dispose();
    await new Session(values.origin, { cookie }).raw('POST', '/api/auth/logout').catch(() => {});
  }
}
