// One agent's flight for demo-repos.mjs: a copy of the host's clone (the host's Git never touches a
// directory an agent has had), one stock agent's run in the Docker sandbox, then the Landing its
// push opened, read through the API until the review agents and CTC have had their say. Each kind
// of agent gets only its own way to its model: GLM its opencode credential on stdin,
// Claude Code and Codex the loopback shim,
// which alone holds the AI Gateway token (agent-sandbox/gateway-shim.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from './agent-run-flow.mjs';
import { opencodeArgs, printable } from './agent-run-plan.mjs';
import { clientEnv, HOOK_LOG, sandboxArgs, sandboxEnv, WORKDIR } from './agent-sandbox.mjs';
import { AGENTS_BY_KIND } from './demo-repos-plan.mjs';
import { opencodeUsage } from './memory-plan.mjs';
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
  return { dir, remote, base: await ws.git(dir, null, 'rev-parse', 'origin/main') };
}

const SHIM = 'http://127.0.0.1:8719';
const QUIET = { DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DO_NOT_TRACK: '1', NO_UPDATE_NOTIFIER: '1' };

/** The command, extra environment and stdin of one run of `kind`. */
function launch(ctx, kind, title, text) {
  const { harness, model } = AGENTS_BY_KIND[kind];
  const shim = () => ({ SANDBOX_GATEWAY_URL: ctx.gateway.url, SANDBOX_GATEWAY_TOKEN: ctx.gateway.token, SANDBOX_GATEWAY_MODEL: model });
  if (harness === 'claude')
    return {
      command: ['claude', '-p', text, '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--plugin-dir', '/opt/yoneda/claude-plugin', '--max-budget-usd', String(ctx.claudeBudget())],
      env: { ...shim(), ...QUIET, ANTHROPIC_BASE_URL: `${SHIM}/anthropic`, ANTHROPIC_API_KEY: 'sandbox-shim', ANTHROPIC_SMALL_FAST_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', YONEDA_MCP_URL: `${ctx.sandboxOrigin}/api/v1/mcp` },
    };
  if (harness === 'codex') return { command: ['node', '/opt/yoneda/codex-run.mjs', model, text], env: { ...shim(), ...QUIET, SANDBOX_SHIM_KEY: 'sandbox-shim', NODE_USE_ENV_PROXY: '1' } };
  const command = ['opencode', ...opencodeArgs({ model, title, text })];
  if (kind === 'glm') return { command, env: {}, credential: ctx.glmCredential };
  throw new Error(`Unsupported sandbox agent: ${kind}`);
}

/** Tokens and dollars out of a run's events. GLM's plan and the opencode cost field say $0. */
export function usageOf(kind, lines) {
  const { harness, rates } = AGENTS_BY_KIND[kind];
  const parsed = lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const priced = (t) => (rates ? ((t.input - t.cache_read) * rates.input + t.cache_read * rates.cache_read + t.output * rates.output) / 1e6 : 0);
  if (harness === 'opencode') {
    const { tokens, session } = opencodeUsage(lines);
    return { session, input: tokens.input + tokens.cache_read, cache_read: tokens.cache_read, output: tokens.output + tokens.reasoning, usd: priced({ input: tokens.input + tokens.cache_read, cache_read: tokens.cache_read, output: tokens.output + tokens.reasoning }) };
  }
  if (harness === 'claude') {
    const result = parsed.findLast((e) => e.type === 'result');
    const u = result?.usage ?? {};
    return { session: result?.session_id ?? null, input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cache_read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, usd: result?.total_cost_usd ?? 0, subtype: result?.subtype ?? null };
  }
  const t = { input: 0, cache_read: 0, output: 0 };
  for (const e of parsed.filter((x) => x.type === 'turn.completed')) {
    t.input += e.usage?.input_tokens ?? 0;
    t.cache_read += e.usage?.cached_input_tokens ?? 0;
    t.output += e.usage?.output_tokens ?? 0;
  }
  return { session: parsed.find((e) => e.type === 'thread.started')?.thread_id ?? null, ...t, usd: priced(t) };
}

/** One agent's run in the sandbox; returns what it did. Fails loudly when it did not finish. */
export async function flyAgent(ctx, r, name, kind, { dir, remote }, text) {
  const { ws, evidence, budget, timeoutS, image } = ctx;
  const agent = `${r.key}-${name}`;
  const egress = ctx.egress[kind];
  const run = launch(ctx, kind, `${r.key} ${name}`, text);
  const env = { ...sandboxEnv({ origin: ctx.sandboxOrigin, token: r.token, remote, credential: run.credential, proxy: egress.address }), ...run.env };
  if (run.opencode) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...JSON.parse(env.OPENCODE_CONFIG_CONTENT), ...run.opencode });
  const container = `yoneda-demo-${agent}-${Date.now().toString(36)}`;
  ctx.containers.push(container);
  const args = sandboxArgs({ name: container, clone: realpathSync(dir), env, command: run.command, network: egress.network, image });
  writeFileSync(join(evidence, `${agent}.command.txt`), `${ws.scrub(printable(['docker', ...args]))}\n`);
  writeFileSync(join(evidence, `${agent}.prompt.txt`), `${text}\n`);
  const done = await runAgent({ task: { agent }, name: container, cwd: ws.dir, env: clientEnv(process.env, env), credential: run.credential, scrub: ws.scrub, args, evidence, timeoutMs: timeoutS * 1000, budget });
  const log = join(dir, HOOK_LOG.slice(WORKDIR.length + 1));
  const hooks = existsSync(log) ? ws.scrub(readFileSync(log, 'utf8')) : '';
  writeFileSync(join(evidence, `${agent}.hooks.jsonl`), hooks);
  const events = join(evidence, `${agent}.events.jsonl`);
  const used = usageOf(kind, existsSync(events) ? readFileSync(events, 'utf8').split('\n') : []);
  if (kind === 'claude') ctx.claudeSpent(used.usd);
  assert.ok(!done.killed && done.code === 0, `${agent}: ${done.killed ?? `exit ${done.code}`} ${done.stderr.slice(-500)}`);
  return { kind, ms: done.ms, ...used, hook_calls: hooks.split('\n').filter(Boolean).length };
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
    // A failed check moves what CTC says at once; the record of it follows the next job.
    const gate = change.status === 'open' ? (await ctx.owner.get(`/repos/${r.id}/changes/${number}/gates`)).land_when_cleared : null;
    const said = gate ?? (change.clearances ?? []).find((c) => c.head === head);
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
