// One agent's flight for demo-repos.mjs: a copy of the host's clone (the host's Git never touches a
// directory an agent has had), one opencode run in the Docker sandbox, then the Landing its push
// opened, read through the API until the review agents and CTC have had their say.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from './agent-run-flow.mjs';
import { opencodeArgs, printable } from './agent-run-plan.mjs';
import { clientEnv, HOOK_LOG, sandboxArgs, sandboxEnv, WORKDIR } from './agent-sandbox.mjs';
import { AGENTS } from './web-agents-pages.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const TERMINAL = new Set(['passed', 'findings', 'failed', 'superseded', 'cancelled', 'paused']);
/** Slop's own limit, 15 minutes, and a minute for the workflow to say so. */
const REVIEW_MS = 16 * 60_000;
const LANDING_MS = 3 * 60_000;
/** How long a Landing has to sit in one state after the checks before it counts. */
const VERDICT_MS = 5 * 60_000;

/** The clone an agent gets: the host's copy at `start`, on `branch`, with the sandbox's remote. */
export async function agentClone(ctx, r, name, { branch, start }) {
  const { ws, remote } = { ws: ctx.ws, remote: `yoneda::${ctx.sandboxOrigin}/${r.id}` };
  await ws.git(r.base, r.token, 'fetch', '-q', '--prune', 'origin');
  const dir = ws.path(`run-${r.key}-${name}-${Date.now().toString(36)}`);
  execFileSync('cp', ['-cR', r.base, dir]);
  await ws.git(dir, null, 'switch', '-q', '-c', branch, start);
  await ws.git(dir, null, 'config', 'user.name', `${r.key} pilot`);
  await ws.git(dir, null, 'config', 'user.email', `pilot-${r.key}@yonedarepo.invalid`);
  await ws.git(dir, null, 'remote', 'set-url', 'origin', remote);
  return { dir, remote };
}

/** One opencode run in the sandbox; returns what it did. Fails loudly when it did not finish. */
export async function flyAgent(ctx, r, name, { dir, remote }, text) {
  const { ws, egress, credential, evidence, budget, model, timeoutS, image } = ctx;
  const agent = `${r.key}-${name}`;
  const env = sandboxEnv({ origin: ctx.sandboxOrigin, token: r.token, remote, credential, proxy: egress.address });
  const container = `yoneda-demo-${agent}-${Date.now().toString(36)}`;
  ctx.containers.push(container);
  const command = ['opencode', ...opencodeArgs({ model, title: `${r.key} ${name}`, text })];
  const args = sandboxArgs({ name: container, clone: realpathSync(dir), env, command, network: egress.network, image });
  writeFileSync(join(evidence, `${agent}.command.txt`), `${printable(['docker', ...args])}\n`);
  writeFileSync(join(evidence, `${agent}.prompt.txt`), `${text}\n`);
  const done = await runAgent({ task: { agent }, name: container, cwd: ws.dir, env: clientEnv(process.env, env), credential, scrub: ws.scrub, args, evidence, timeoutMs: timeoutS * 1000, budget });
  const log = join(dir, HOOK_LOG.slice(WORKDIR.length + 1));
  const hooks = existsSync(log) ? ws.scrub(readFileSync(log, 'utf8')) : '';
  writeFileSync(join(evidence, `${agent}.hooks.jsonl`), hooks);
  assert.ok(!done.killed && done.code === 0, `${agent}: ${done.killed ?? `exit ${done.code}`} ${done.stderr.split('\n').pop()}`);
  const events = hooks.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { ms: done.ms, cost: done.cost, hook_calls: events.length, started_hook: events.some((e) => e.event === 'opencode-start') };
}

/** The Landing on `branch`, open or already landed. */
export async function landingOn(ctx, r, branch) {
  const started = Date.now();
  for (;;) {
    for (const status of ['open', 'landed']) {
      const { changes } = await ctx.owner.get(`/repos/${r.id}/changes?status=${status}`);
      const found = changes.find((c) => c.branch === branch);
      if (found) return found;
    }
    assert.ok(Date.now() - started < LANDING_MS, `no Landing on ${branch} after ${LANDING_MS / 1000} s`);
    await sleep(3000);
  }
}

/** Each review agent's finished run on `head`. */
export async function reviewsOn(ctx, r, head) {
  const started = Date.now();
  for (;;) {
    const { runs } = await ctx.account.get(`${ctx.managed}/runs?repo=${r.id}&limit=50`);
    const mine = AGENTS.map((a) => runs.find((run) => run.agent === a.id && run.head === head));
    if (mine.every((run) => run && TERMINAL.has(run.status))) return mine;
    assert.ok(Date.now() - started < REVIEW_MS, `reviews on ${head.slice(0, 8)}: ${mine.map((run, i) => `${AGENTS[i].id}:${run?.status ?? 'none'}`).join(' ')}`);
    await sleep(5000);
  }
}

const brief = (run) => ({ status: run.status, value: run.value, findings: run.findings, cost_usd: run.cost_usd, model: `${run.provider}/${run.model}`, error: run.error ?? null, summary: String(run.summary ?? '').slice(0, 200) });

/** What the Landing settles as once its reviews are in: landed, or CTC's newest word on its head. */
export async function verdictOn(ctx, r, number, head, want) {
  const started = Date.now();
  for (;;) {
    const change = await ctx.owner.get(`/repos/${r.id}/changes/${number}`);
    const said = (change.clearances ?? []).find((c) => c.head === head);
    const outcome = change.status === 'landed' ? 'landed' : (said?.decision ?? 'none');
    if (outcome === want || Date.now() - started > VERDICT_MS) return { outcome, status: change.status, landed_commit: change.landed_commit ?? null, reasons: said?.reasons?.map((x) => `${x.code}: ${x.reason}`) ?? [] };
    await sleep(5000);
  }
}

/** The whole wait after a push: its Landing, both reviews, the verdict. `want` ends the wait early. */
export async function settleLanding(ctx, r, branch, want) {
  const opened = await landingOn(ctx, r, branch);
  const change = await ctx.owner.get(`/repos/${r.id}/changes/${opened.number}`);
  const head = change.head;
  const [slop, drift] = await reviewsOn(ctx, r, head);
  const verdict = await verdictOn(ctx, r, opened.number, head, want);
  return { number: opened.number, head, plan: change.flight_plan?.goal ?? null, slop: brief(slop), drift: brief(drift), ...verdict };
}
