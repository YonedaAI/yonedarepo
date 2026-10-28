// Item 29 of the staging kit (L3 of the agent e2e strategy, real agents, paid): N local
// opencode agents (GLM by default) in separate yoneda:: clones of one fresh repository, each
// adding its own function to src/util.js and its own line to CHANGELOG.md (overlapping files)
// and pushing to main at the same time; then a second wave does the same. Each agent runs
// `opencode run --standalone` with the yoneda plugin from this checkout (session context,
// declared reads, session records) and its own repository token. Afterwards a fresh clone of
// main must hold every agent's function and line (no lost writes), no merge commit made in a
// clone (server merges of concurrent pushes are the platform's), a session record on every
// agent commit, and each second-wave agent's start context must name a first-wave session.
// Caps: a per-agent time limit and a spend budget over every agent's reported cost (the runs
// are killed when it is exceeded). Evidence per agent in .local/staging/agents-<ts>/: the
// exact command (environment names only), opencode's JSON events and the plugin's hook log.
// The repository is deleted.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { costOf, opencodeArgs, opencodeConfig, printable, prompt, tasks, verdict } from './agent-run-plan.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const b64 = (text) => Buffer.from(text).toString('base64');
const NO_SESSION = { YONEDA_SESSION_ID: '', OPENCODE_SESSION_ID: '' };

/** Whether the yoneda plugin is installed in opencode's global plugin directory. */
function installedGlobally() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return existsSync(join(base, 'opencode/plugins/yoneda/index.ts'));
}

/** Runs one agent to completion, the time limit or `budget.abort`; returns its outcome. */
function runAgent({ task, dir, env, scrub, args, evidence, timeoutMs, budget }) {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn('opencode', args, { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    let partial = '';
    let stderr = '';
    let reason = null;
    const kill = (why) => {
      reason ??= why;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
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
function spendBudget(limit) {
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

/** 29: `agents` agents, then `wave2` more, on one repository; see the header. */
export async function agentRun(kit, { root, agents = 4, wave2 = 2, model, timeoutS = 600, budgetUsd = 2 }, metrics) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const version = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) return { skip: 'opencode is not on PATH' };
  Object.assign(metrics, { opencode: version.stdout.trim(), model, agents, wave2, time_limit_s: timeoutS, budget_usd: budgetUsd });
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
  const pluginDir = join(root, 'plugins/opencode/yoneda');
  const config = opencodeConfig(pluginDir, installedGlobally());
  const budget = spendBudget(budgetUsd);
  const tokens = [];

  /** One wave: clones and repository tokens, then every agent at once. */
  const wave = async (list) => {
    const runs = [];
    for (const task of list) {
      const dir = kit.path(`agent-${task.agent}`);
      await kit.ok('git', ['clone', '-q', kit.remote(repo), dir]);
      await kit.gitOk(dir, 'config', 'user.name', `Kit agent ${task.agent}`);
      await kit.gitOk(dir, 'config', 'user.email', task.email);
      const minted = await api.post(`/repos/${repo}/tokens`, { name: `kit-${task.agent}`, scopes: ['read', 'write', 'land'] });
      tokens.push(minted.token);
      // opencode keeps its own configuration and credentials (no XDG_CONFIG_HOME override);
      // the CLI and Git get this agent's repository token and the kit's Git config.
      const extra = {
        ...NO_SESSION,
        PATH: `${kit.bin}:${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: kit.gitConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        YONEDA_ORIGIN: kit.api,
        YONEDA_TOKEN: minted.token,
        YONEDA_HOOK_LOG: join(evidence, `${task.agent}.hooks.jsonl`),
        OPENCODE_CONFIG_CONTENT: config,
      };
      const scrub = (text) => tokens.reduce((t, secret) => t.split(secret).join('[token]'), kit.scrub(text));
      const args = opencodeArgs({ model, title: `kit ${task.agent}`, text: prompt(task) });
      const command = printable({ dir, envNames: Object.keys(extra), args });
      writeFileSync(join(evidence, `${task.agent}.command.txt`), `${command}\n`);
      console.log(`  ${task.agent}: ${command}`);
      runs.push({ task, dir, env: { ...process.env, ...extra }, scrub, args, evidence, timeoutMs: timeoutS * 1000, budget });
    }
    return Promise.all(runs.map(runAgent));
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
  assert.ok(judged.problems.length === 0, judged.problems.join('; '));
}
