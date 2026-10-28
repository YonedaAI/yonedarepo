// Kit item 30 (`--dogfood --dogfood-agents N`), the agent half: N real opencode agents, each in
// its own Docker sandbox (agent-sandbox.mjs: only its clone mounted, allowlisted environment,
// the model credential on stdin, no host or LAN egress), each in a yoneda:: clone of the
// owner's repository on its own scratch branch with its own read/write repository token (no
// land scope: protected main cannot move). Each reads one real file and adds a two-line note
// under .dogfood/, commits and pushes its branch; the kit then opens a change for it and
// requires the change to touch only that note and its head's opencode session record to be
// listed on the change page, then closes the change. The host checkouts and remotes are
// checked by the caller around the whole run. Evidence (commands, events, hook logs) goes to
// the run's evidence directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { opencodeArgs, printable } from './agent-run-plan.mjs';
import { runAgent, spendBudget } from './agent-run-flow.mjs';
import { clientEnv, HOOK_LOG, sandboxArgs, sandboxEnv, sandboxOrigin, WORKDIR } from './agent-sandbox.mjs';
import { buildSandbox, dockerAvailable, modelCredential } from './agent-sandbox-host.mjs';
import { agentProblems, agentTask, scratch } from './dogfood-plan.mjs';

const q = (params) => new URLSearchParams(params).toString();

/** 30.5: `agents` sandboxed agents on the owner's repository (see the header). */
export async function dogfoodAgents(ctx, { agents, model, timeoutS, budgetUsd }, metrics) {
  const { ws, repo, ts, owner, mint, secrets, evidence, root } = ctx;
  if (!agents) return { skip: 'no agents (--dogfood-agents N)' };
  if (!dockerAvailable()) return { skip: 'Docker is not available, and agents run only in the sandbox' };
  if (!existsSync(join(ws.bin, 'git-remote-yoneda'))) return { skip: `no git-remote-yoneda in ${ws.bin}` };
  const credential = await modelCredential(model, ws.dir);
  for (const entry of JSON.parse(credential)) for (const v of [entry.value?.key, entry.value?.access]) if (v) secrets.add(v);
  const sandbox = await buildSandbox(root);
  Object.assign(metrics, { opencode: sandbox.opencode, sandbox: sandbox.image.slice(0, 19), model, agents, time_limit_s: timeoutS, budget_usd: budgetUsd });
  const { origin, hostPort } = sandboxOrigin(ws.api);
  const remote = `yoneda::${origin}/${repo}`;
  const budget = spendBudget(budgetUsd);
  const tasks = Array.from({ length: agents }, (_, i) => agentTask(i + 1, ts));
  const containers = [];
  const runs = [];
  try {
    for (const task of tasks) {
      const token = await mint(task.agent, ['read', 'write']);
      const dir = ws.path(task.agent);
      const started = performance.now();
      await ws.ok('git', ['clone', '-q', `yoneda::${ws.api}/${repo}`, dir], { token });
      task.clone_ms = Math.round(performance.now() - started);
      task.base = await ws.git(dir, null, 'rev-parse', 'HEAD');
      await ws.git(dir, null, 'switch', '-q', '-c', scratch(task.branch, ts));
      await ws.git(dir, null, 'config', 'user.name', `Dogfood ${task.agent}`);
      await ws.git(dir, null, 'config', 'user.email', task.email);
      // The URL the platform has from inside the container; the sandbox refuses any other.
      await ws.git(dir, null, 'remote', 'set-url', 'origin', remote);
      const env = sandboxEnv({ origin, token, remote, hostPort, credential });
      const name = `yoneda-dogfood-${task.n}-${Date.now().toString(36)}`;
      containers.push(name);
      const args = sandboxArgs({ name, clone: realpathSync(dir), env, command: ['opencode', ...opencodeArgs({ model, title: `dogfood ${task.agent}`, text: task.text })], image: sandbox.image });
      writeFileSync(join(evidence, `${task.agent}.command.txt`), `${printable(['docker', ...args])}\n`);
      runs.push({ task, name, cwd: ws.dir, env: clientEnv(process.env, env), credential, scrub: ws.scrub, args, evidence, timeoutMs: timeoutS * 1000, budget });
    }
    const outcomes = await Promise.all(runs.map(runAgent));
    metrics.agent_ms = outcomes.map((o) => `${o.agent}:${o.ms}`).join(',');
    metrics.exits = outcomes.map((o) => `${o.agent}:${o.killed ?? o.code}`).join(',');
    const spent = outcomes.map((o) => o.cost).filter((c) => c !== null);
    metrics.spend_usd = spent.length ? Number(spent.reduce((a, b) => a + b, 0).toFixed(4)) : 'not reported by opencode';
    for (const { task } of runs) {
      const log = join(ws.path(task.agent), HOOK_LOG.slice(WORKDIR.length + 1));
      if (existsSync(log)) writeFileSync(join(evidence, `${task.agent}.hooks.jsonl`), ws.scrub(readFileSync(log, 'utf8')));
    }
    const problems = outcomes.filter((o) => o.killed || o.code !== 0).map((o) => `${o.agent} did not finish: ${o.killed ?? `exit ${o.code}`} ${o.stderr.split('\n').pop()}`);
    metrics.agents_result = {};
    for (const task of tasks) problems.push(...(await judge(ctx, task, metrics)));
    assert.ok(problems.length === 0, problems.join('; '));
  } finally {
    for (const name of containers) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
}

/** Opens the agent's change, reads what the change page shows, closes it; returns problems. */
async function judge({ repo, ts, owner, changes }, task, metrics) {
  const path = `/repos/${repo}`;
  const head = (await owner.get(`${path}/refs`)).refs[`refs/heads/${task.branch}`] ?? null;
  const seen = { head, base: task.base };
  if (head && head !== task.base) {
    seen.paths = ((await owner.get(`${path}/diff?${q({ base: task.base, head })}`)).changes ?? []).map((c) => c.path);
    seen.sessions = (await owner.get(`${path}/commits/${head}/sessions`)).sessions ?? [];
    const opened = await owner.post(`${path}/changes`, { branch: scratch(task.branch, ts), title: `Dogfood ${task.agent}`, body: `Agent ${task.n}'s note; closed by the dogfood kit.` });
    changes.push(opened.number);
    const listed = await owner.get(`${path}/sessions?${q({ head, base: task.base, limit: 200 })}`);
    seen.listed = (listed.sessions ?? []).map((s) => s.id);
    await owner.post(`${path}/changes/${opened.number}/close`);
    seen.change = opened.number;
  }
  metrics.agents_result[task.agent] = { head: head?.slice(0, 12) ?? null, change: seen.change, paths: seen.paths, sessions: seen.sessions?.length ?? 0, clone_ms: task.clone_ms };
  return agentProblems(task, seen);
}
