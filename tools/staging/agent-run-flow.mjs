// Item 29 of the staging kit (L3 of the agent e2e strategy, real agents, paid): N opencode
// agents (GLM by default) in separate yoneda:: clones of one fresh repository, each adding its
// own function to src/util.js and its own line to CHANGELOG.md (overlapping files) and pushing
// to main at the same time; then a second wave does the same. Each agent runs
// `opencode run --standalone` with the yoneda plugin (session context, declared reads, session
// records) and its own repository token, only ever in its own sandbox container
// (agent-sandbox.mjs): its clone is the only host path it sees, it gets no host environment,
// configuration or credential but the model's (on stdin), and egress cannot reach the host or
// the LAN. The host checkouts and their remotes are snapshotted before the agents start and
// compared afterwards: any change fails the item loudly. Afterwards a fresh clone of main must
// hold every agent's function and line (no lost writes), no merge commit made in a clone
// (server merges of concurrent pushes are the platform's), a session record on every agent
// commit, and each second-wave agent's start context must name a first-wave session.
// Caps: a per-agent time limit and a spend budget over every agent's reported cost (the
// containers are killed when it is exceeded). Evidence per agent in .local/staging/agents-<ts>/:
// the exact docker command (environment names only), opencode's JSON events and the plugin's
// hook log. The repository is deleted.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { costOf, opencodeArgs, printable, prompt, tasks, verdict } from './agent-run-plan.mjs';
import { clientEnv, egressAllowlist, FAKE_OPENCODE, GUARD_EXIT, HOOK_LOG, hostDrift, sandboxArgs, sandboxEnv, sandboxOrigin, WORKDIR } from './agent-sandbox.mjs';
import { buildSandbox, dockerAvailable, hostState, modelCredential, startEgress } from './agent-sandbox-host.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const b64 = (text) => Buffer.from(text).toString('base64');

/** Runs one agent's container to completion, the time limit or `budget.abort`; returns its
 * outcome. The model credential (if any) is the container's stdin. */
export function runAgent({ task, name, cwd, env, credential, scrub, args, evidence, timeoutMs, budget }) {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn('docker', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(credential ?? '');
    const lines = [];
    let partial = '';
    let stderr = '';
    let reason = null;
    const kill = (why) => {
      reason ??= why;
      spawnSync('docker', ['kill', name], { env, stdio: 'ignore' });
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill(`time limit ${timeoutMs / 1000} s`), timeoutMs);
    const offBudget = budget.onAbort(() => kill('spend budget reached'));
    child.stdout.on('data', (chunk) => {
      partial += chunk;
      const complete = partial.split('\n');
      partial = complete.pop() ?? '';
      for (const line of complete) {
        lines.push(line);
        appendFileSync(join(evidence, `${task.agent}.events.jsonl`), `${scrub(line)}\n`);
      }
      budget.report(task.agent, costOf(lines));
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      offBudget();
      if (partial) lines.push(partial);
      done({ agent: task.agent, code, signal, killed: reason, ms: Math.round(performance.now() - started), cost: costOf(lines), stderr: scrub(stderr).slice(-600) });
    });
  });
}

/** The spend across agents; past `limit` dollars every run is told to stop. */
export function spendBudget(limit) {
  const spent = new Map();
  const listeners = new Set();
  let aborted = false;
  return {
    report(agent, cost) {
      if (cost === null) return;
      spent.set(agent, cost);
      if (!aborted && this.total() > limit) {
        aborted = true;
        for (const stop of listeners) stop();
      }
    },
    total: () => [...spent.values()].reduce((a, b) => a + b, 0),
    onAbort(stop) {
      if (aborted) stop();
      listeners.add(stop);
      return () => listeners.delete(stop);
    },
    get aborted() {
      return aborted;
    },
  };
}

/** The host checkouts' and remotes' changes since `before`, as problems ([] when none). */
async function hostProblems(before, watched) {
  try {
    return hostDrift(before, await hostState(watched));
  } catch (e) {
    return [`the host could not be re-checked after the run: ${e.message}`];
  }
}

/**
 * 29: `agents` agents, then `wave2` more, on one repository; see the header. `fake`: the image's
 * scripted stand-in for opencode instead of opencode (tests/agents/e2e.mjs, no model).
 */
export async function agentRun(kit, { root, agents = 4, wave2 = 2, model, timeoutS = 600, budgetUsd = 2, fake = false }, metrics) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  if (!dockerAvailable()) return { skip: 'Docker is not available, and agents run only in the sandbox' };
  const credential = fake ? null : await modelCredential(model, kit.dir);
  const sandbox = await buildSandbox(root);
  Object.assign(metrics, { opencode: fake ? 'scripted (fake-opencode)' : sandbox.opencode, sandbox: sandbox.image.slice(0, 19), model, agents, wave2, time_limit_s: timeoutS, budget_usd: budgetUsd });
  // Every checkout this process could be confused with, and their remotes, before any agent.
  const watched = [root, process.cwd(), process.env.PWD];
  const before = await hostState(watched);
  metrics.host_checkouts = Object.keys(before.checkouts).length;
  metrics.host_remotes = Object.keys(before.remotes).length;
  const containers = [];
  // The agents' only way out: the platform and (for a real model) its provider's API.
  const allow = egressAllowlist({ origin: sandboxOrigin(kit.api).origin, model: fake ? null : model });
  const egress = await startEgress({ image: sandbox.image, allow, run: Date.now().toString(36) });
  metrics.egress_allow = allow.join(',');
  try {
    await agentWaves(kit, { root, agents, wave2, model, timeoutS, budgetUsd, fake, credential, image: sandbox.image, network: egress.network, containers }, metrics);
  } finally {
    for (const name of containers) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    metrics.egress_refused = (await egress.stop()).join(',') || 'none';
    const drift = await hostProblems(before, watched);
    metrics.host_unchanged = drift.length === 0;
    if (drift.length) {
      console.error(`\n!!! HOST CHANGED DURING THE AGENT RUN (item 29) !!!\n${drift.map((d) => `  - ${d}`).join('\n')}\n`);
      assert.fail(`HOST CHANGED during the agent run: ${drift.join('; ')}`);
    }
  }
}

async function agentWaves(kit, { root, agents, wave2, model, timeoutS, budgetUsd, fake, credential, image, network, containers }, metrics) {
  const api = kit.pat();
  const name = `kit-agents-${Date.now()}`;
  const files = [
    { path: 'src/util.js', content_b64: b64('// Small utilities. Each change adds one exported function below.\n') },
    { path: 'CHANGELOG.md', content_b64: b64('# Changelog\n') },
  ];
  const repo = (await api.post('/repos', { name, policy: { approvals: 0, required_checks: [] }, files, author })).id;
  kit.repos.push({ id: repo, name });
  metrics.repo = repo;
  const evidence = join(root, `.local/staging/agents-${Date.now()}`);
  mkdirSync(evidence, { recursive: true });
  metrics.evidence = evidence;
  const { origin } = sandboxOrigin(kit.api);
  const remote = kit.remote(repo, origin);
  const budget = spendBudget(budgetUsd);
  const secrets = credential ? JSON.parse(credential).map((e) => e.value?.key ?? e.value?.access).filter(Boolean) : [];
  const scrub = (text) => secrets.reduce((t, secret) => t.split(secret).join('[secret]'), kit.scrub(text));

  /** One wave: clones and repository tokens, then every agent's container at once. */
  const wave = async (list) => {
    const runs = [];
    for (const task of list) {
      const dir = kit.path(`agent-${task.agent}`);
      await kit.ok('git', ['clone', '-q', kit.remote(repo), dir]);
      await kit.gitOk(dir, 'config', 'user.name', `Kit agent ${task.agent}`);
      await kit.gitOk(dir, 'config', 'user.email', task.email);
      // The URL the platform has from inside the container; the sandbox refuses any other.
      await kit.gitOk(dir, 'remote', 'set-url', 'origin', remote);
      const minted = await api.post(`/repos/${repo}/tokens`, { name: `kit-${task.agent}`, scopes: ['read', 'write', 'land'] });
      secrets.push(minted.token);
      const env = sandboxEnv({ origin, token: minted.token, remote, credential });
      const container = `yoneda-kit-${task.agent}-${Date.now().toString(36)}`;
      containers.push(container);
      const command = [...(fake ? FAKE_OPENCODE : ['opencode']), ...opencodeArgs({ model, title: `kit ${task.agent}`, text: prompt(task) })];
      const args = sandboxArgs({ name: container, clone: realpathSync(dir), env, command, network, image });
      const line = printable(['docker', ...args]);
      writeFileSync(join(evidence, `${task.agent}.command.txt`), `${line}\n`);
      console.log(`  ${task.agent}: ${line.slice(0, 300)}…`);
      runs.push({ task, name: container, cwd: kit.path(), env: clientEnv(process.env, env), credential, scrub, args, evidence, timeoutMs: timeoutS * 1000, budget });
    }
    const done = await Promise.all(runs.map(runAgent));
    // The plugin's hook log, written inside the clone (the container's only mount).
    for (const { task } of runs) {
      const log = join(kit.path(`agent-${task.agent}`), HOOK_LOG.slice(WORKDIR.length + 1));
      if (existsSync(log)) writeFileSync(join(evidence, `${task.agent}.hooks.jsonl`), scrub(readFileSync(log, 'utf8')));
    }
    return done;
  };

  const first = tasks(agents, 1);
  const second = wave2 > 0 ? tasks(wave2, 2, agents) : [];
  const outcomes = await wave(first);
  const summaries = (await api.get(`/repos/${repo}/sessions?limit=50`)).sessions
    .filter((s) => String(s.session_id ?? '').startsWith('opencode:'))
    .map((s) => s.summary);
  if (second.length && !budget.aborted) outcomes.push(...(await wave(second)));

  // What each second-wave agent's session started with (the plugin's hook log).
  const contexts = {};
  for (const t of second) {
    const log = join(evidence, `${t.agent}.hooks.jsonl`);
    const start = existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'opencode-start')
      : undefined;
    contexts[t.agent] = start?.output ?? '';
  }

  const check = kit.path('agents-main');
  await kit.ok('git', ['clone', '-q', kit.remote(repo), check]);
  const log = (await kit.gitOk(check, 'log', '--format=%H %P|%ae|%ce', 'main')).split('\n').map((line) => {
    const [ids, authorEmail, committer] = line.split('|');
    const [sha, ...parents] = ids.trim().split(' ');
    return { sha, parents, author: authorEmail, committer };
  });
  const sessions = {};
  for (const c of log.filter((c) => c.parents.length === 1)) sessions[c.sha] = (await api.get(`/repos/${repo}/commits/${c.sha}/sessions`)).sessions;
  const all = [...first, ...second];
  const judged = verdict({
    tasks: all,
    util: readFileSync(join(check, 'src/util.js'), 'utf8'),
    changelog: readFileSync(join(check, 'CHANGELOG.md'), 'utf8'),
    log,
    sessions,
    contexts,
    summaries,
  });
  const spent = outcomes.map((o) => o.cost).filter((c) => c !== null);
  Object.assign(metrics, judged.metrics, {
    spend_usd: spent.length ? Number(spent.reduce((a, b) => a + b, 0).toFixed(4)) : 'not reported by opencode',
    agent_ms: outcomes.map((o) => `${o.agent}:${o.ms}`).join(','),
    exits: outcomes.map((o) => `${o.agent}:${o.killed ?? o.code}`).join(','),
    first_wave_summaries: summaries.length,
  });
  writeFileSync(join(evidence, 'outcome.json'), `${JSON.stringify({ metrics, outcomes, problems: judged.problems }, null, 2)}\n`);
  // No hook call at all: opencode did not load the plugin (OPENCODE_CONFIG_CONTENT's plugins).
  const silent = all.filter((t) => !existsSync(join(evidence, `${t.agent}.hooks.jsonl`)));
  if (silent.length) judged.problems.unshift(`the yoneda plugin made no hook call in ${silent.map((t) => t.agent).join(', ')} (not loaded?)`);
  const failed = outcomes.filter((o) => o.killed || o.code !== 0);
  if (failed.length) judged.problems.unshift(`${failed.length} agent run(s) did not finish: ${failed.map((o) => `${o.agent} ${o.killed ?? `exit ${o.code}`} ${o.stderr.split('\n').pop()}`).join('; ')}`);
  // A sandbox guard refusal: the clone or opencode's directory was not what the kit set up.
  const guarded = outcomes.filter((o) => o.code === GUARD_EXIT).map((o) => o.agent);
  for (const t of all)
    if (existsSync(join(evidence, `${t.agent}.hooks.jsonl`)) && readFileSync(join(evidence, `${t.agent}.hooks.jsonl`), 'utf8').includes('"event":"opencode-guard"')) guarded.push(t.agent);
  if (guarded.length) judged.problems.unshift(`the sandbox guard refused ${[...new Set(guarded)].join(', ')} (wrong clone, origin or directory)`);
  assert.ok(judged.problems.length === 0, judged.problems.join('; '));
}
