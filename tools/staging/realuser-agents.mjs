// Kit item 30 (`--realuser --realuser-agents N`), the agent half: N real opencode agents on each
// of several test repositories at once, each in its own Docker sandbox (agent-sandbox.mjs: only
// its clone mounted, allowlisted environment, the model credential on stdin, no host or LAN
// egress), each in a yoneda:: clone on its own scratch branch with its own read/write
// repository token (no land scope: protected main cannot move). Each makes one small real edit
// suited to the repository (a clarity fix in a doc, a short comment in a source file) to a
// file of its own and pushes its branch. Then, per agent, the kit opens a change to the
// repository's scratch base, requires its diff to be that one file and its head's opencode
// session to be listed on the change, and lands it through the change (rebasing it on the
// server first when another agent's landing got there first). Host checkouts and remotes are
// checked by the caller around the whole run. Evidence (commands, events, hook logs) goes to
// the run's evidence directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { opencodeArgs, printable } from './agent-run-plan.mjs';
import { runAgent, spendBudget } from './agent-run-flow.mjs';
import { clientEnv, egressAllowlist, HOOK_LOG, sandboxArgs, sandboxEnv, sandboxOrigin, WORKDIR } from './agent-sandbox.mjs';
import { buildSandbox, dockerAvailable, modelCredential, startEgress } from './agent-sandbox-host.mjs';
import { agentProblems, agentTargets, agentTask, scratch, scratchRefs } from './realuser-plan.mjs';

const q = (params) => new URLSearchParams(params).toString();

/** 30.5: `perRepo` sandboxed agents on each of `repos` (`{ id, name }`), all at once. */
export async function realuserAgents(ctx, { repos, perRepo, model, timeoutS, budgetUsd }, metrics) {
  const { ws, secrets, evidence, root } = ctx;
  if (!perRepo) return { skip: 'no agents (--realuser-agents N)' };
  if (!repos.length) return { skip: 'no agent repositories (--agent-repos, --import-defaults)' };
  if (!dockerAvailable()) return { skip: 'Docker is not available, and agents run only in the sandbox' };
  if (!existsSync(join(ws.bin, 'git-remote-yoneda'))) return { skip: `no git-remote-yoneda in ${ws.bin}` };
  const credential = await modelCredential(model, ws.dir);
  for (const entry of JSON.parse(credential)) for (const v of [entry.value?.key, entry.value?.access]) if (v) secrets.add(v);
  const sandbox = await buildSandbox(root);
  Object.assign(metrics, { opencode: sandbox.opencode, sandbox: sandbox.image.slice(0, 19), model, repos: repos.map((r) => r.name).join(','), per_repo: perRepo, time_limit_s: timeoutS, budget_usd: budgetUsd });
  const { origin } = sandboxOrigin(ws.api);
  const budget = spendBudget(budgetUsd);
  const containers = [];
  const runs = [];
  // The agents' only way out: the platform and the model provider's API.
  const allow = egressAllowlist({ origin, model });
  const egress = await startEgress({ image: sandbox.image, allow, run: Date.now().toString(36) });
  metrics.egress_allow = allow.join(',');
  try {
    for (const repo of repos) runs.push(...(await prepareRepo(ctx, repo, { perRepo, origin, credential, model, image: sandbox.image, network: egress.network, budget, timeoutS, containers })));
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
    // One landing at a time: agents of one repository share its scratch base.
    for (const { task } of runs) problems.push(...(await judge(ctx, task, metrics)));
    assert.ok(problems.length === 0, problems.join('; '));
  } finally {
    for (const name of containers) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    metrics.egress_refused = (await egress.stop()).join(',') || 'none';
  }
}

/** The repository's scratch base at main, and its agents' clones, tokens and containers. */
async function prepareRepo(ctx, repo, { perRepo, origin, credential, model, image, network, budget, timeoutS, containers }) {
  const { ws, ts, owner, mint, evidence } = ctx;
  ctx.touch(repo.id);
  const base = scratch(scratchRefs(ts).agentBase, ts);
  const main = (await owner.get(`/repos/${repo.id}/refs`)).refs['refs/heads/main'];
  assert.ok(main, `${repo.name} has no main`);
  await owner.post(`/repos/${repo.id}/refs/batch`, { updates: [{ ref: base, commit: main, expected: null }] });
  const remote = `yoneda::${origin}/${repo.id}`;
  const runs = [];
  let targets = null;
  for (let n = 1; n <= perRepo; n++) {
    const agent = `${repo.name}-agent-${n}`;
    const token = await mint(agent, ['read', 'write'], repo.id);
    const dir = ws.path(agent);
    // The targets come from one planning clone (lazy, its tip checked out): file sizes need
    // the blobs, which the agents' own clones never fetch outside their scope.
    if (!targets) {
      const plan = ws.path(`${repo.name}-plan`);
      await ws.ok('git', ['clone', '-q', `yoneda::${ws.api}/${repo.id}`, plan], { token });
      targets = agentTargets(await ws.git(plan, null, 'ls-tree', '-r', '-l', 'HEAD'), perRepo);
    }
    const target = targets[n - 1];
    const started = performance.now();
    // The agent default: a lazy clone (commits and trees) checked out only in the task's
    // directory (Git's cone mode: its files and the top's), so the agent fetches the blobs
    // there and whatever else Git needs on first use, not the whole tip.
    await ws.ok('git', ['clone', '-q', '--no-checkout', `yoneda::${ws.api}/${repo.id}`, dir], { token });
    const scope = target?.includes('/') ? [target.slice(0, target.lastIndexOf('/'))] : [];
    await ws.git(dir, token, 'sparse-checkout', 'set', '--cone', '--sparse-index', ...scope);
    const planned = agentTask({ n, ts, repo: repo.name, target });
    await ws.ok('git', ['switch', '-q', '-c', scratch(planned.branch, ts), main], { cwd: dir, token });
    const clone_ms = Math.round(performance.now() - started);
    const lazy = readFileSync(join(dir, '.git/config'), 'utf8').includes('partialclonefilter = blob:none');
    const task = { ...planned, repoId: repo.id, base, main, clone_ms, lazy, scope: scope.join(',') || '/', dir };
    await ws.git(dir, null, 'config', 'user.name', `Real-user ${agent}`);
    await ws.git(dir, null, 'config', 'user.email', task.email);
    // The URL the platform has from inside the container; the sandbox refuses any other.
    await ws.git(dir, null, 'remote', 'set-url', 'origin', remote);
    const env = sandboxEnv({ origin, token, remote, credential });
    const name = `yoneda-realuser-${n}-${Date.now().toString(36)}`;
    containers.push(name);
    const args = sandboxArgs({ name, clone: realpathSync(dir), env, command: ['opencode', ...opencodeArgs({ model, title: `realuser ${agent}`, text: task.text })], network, image });
    writeFileSync(join(evidence, `${agent}.command.txt`), `${printable(['docker', ...args])}\n`);
    runs.push({ task, name, cwd: ws.dir, env: clientEnv(process.env, env), credential, scrub: ws.scrub, args, evidence, timeoutMs: timeoutS * 1000, budget });
  }
  return runs;
}

/** Opens the agent's change to the scratch base, reads what it shows, lands it through the
 * change when its diff is only the agent's file; returns problems. */
async function judge({ ts, owner, changes }, task, metrics) {
  const path = `/repos/${task.repoId}`;
  const head = (await owner.get(`${path}/refs`)).refs[`refs/heads/${task.branch}`] ?? null;
  const seen = { head, base: task.main };
  if (head && head !== task.main) {
    seen.paths = ((await owner.get(`${path}/diff?${q({ base: task.main, head })}`)).changes ?? []).map((c) => c.path);
    seen.sessions = (await owner.get(`${path}/commits/${head}/sessions`)).sessions ?? [];
    const opened = await owner.post(`${path}/changes`, { branch: scratch(task.branch, ts), base: task.base, title: `Real-user ${task.agent}`, body: `${task.kind === 'doc' ? 'A clarity fix' : 'A short comment'} in ${task.target}, by a sandboxed agent.` });
    changes.push({ repo: task.repoId, number: opened.number });
    seen.change = opened.number;
    seen.listed = ((await owner.get(`${path}/sessions?${q({ head, base: task.main, limit: 200 })}`)).sessions ?? []).map((s) => s.id);
    if (seen.paths.join() === task.target) seen.status = (await landThrough(owner, path, opened.number, ts, seen)).status;
  }
  metrics.agents_result[task.agent] = { target: task.target, head: head?.slice(0, 12) ?? null, change: seen.change, status: seen.status, rebased: seen.rebased, paths: seen.paths, sessions: seen.sessions?.length ?? 0, clone_ms: task.clone_ms, lazy: task.lazy, scope: task.scope, fetch: fetchEfficiency(seen.sessions, task.dir) };
  return agentProblems(task, seen);
}

const mib = (bytes) => (bytes / 1024 / 1024).toFixed(2);

/** Fetch efficiency of an agent's lazy clone: bytes fetched from the platform against bytes of
 * the files it read, from its session record, else from the clone's own tally (`.git/yoneda/`,
 * the helper in the container and the clone on the host both write it). */
function fetchEfficiency(sessions, dir) {
  const recorded = (sessions ?? []).find((s) => s.fetched_bytes != null);
  let fetched = recorded?.fetched_bytes;
  let read = recorded?.read_bytes ?? 0;
  let from = 'session record';
  if (fetched == null) {
    const lines = (name) => (existsSync(join(dir, '.git/yoneda', name)) ? readFileSync(join(dir, '.git/yoneda', name), 'utf8').split('\n') : []);
    fetched = lines('fetched').reduce((sum, l) => sum + (Number(l.split(' ')[2]) || 0), 0);
    read = lines('read-bytes').reduce((sum, l) => sum + (Number(l.split(' ')[0]) || 0), 0);
    from = 'clone tally';
  }
  const ratio = read > 0 ? ` (${(fetched / read).toFixed(1)}x)` : '';
  return `fetched ${mib(fetched)} of ${mib(read)} MiB read${ratio}, ${from}`;
}

/** Lands change `number` on its base; when the base moved under it (another agent landed),
 * rebases the branch onto the base on the server and lands again, as a person would. */
async function landThrough(owner, path, number, ts, seen) {
  const land = async () => {
    const change = await owner.get(`${path}/changes/${number}`);
    return owner.raw('POST', `${path}/land`, { ref: scratch(change.base, ts), commit: change.head });
  };
  let landed = await land();
  if (!landed.ok && [409, 412].includes(landed.status)) {
    const change = await owner.get(`${path}/changes/${number}`);
    const branch = scratch(change.branch, ts).split('/').map(encodeURIComponent).join('/');
    await owner.post(`${path}/branches/${branch}/rebase`, { onto: scratch(change.base, ts) });
    seen.rebased = true;
    landed = await land();
  }
  assert.ok(landed.ok, `landing change #${number}: ${landed.status} ${landed.body?.error?.message ?? ''}`);
  return owner.get(`${path}/changes/${number}`);
}
