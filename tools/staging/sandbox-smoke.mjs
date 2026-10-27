// Sandbox smoke: the agent smoke's brief and policy on runtime `sandbox-cli-v1` (a stock coding
// CLI in a Cloudflare Sandbox, cheap managed GLM or MiMo). `cli` (`--cli`) picks the CLI every
// agent runs: claude (default), opencode, mimo (MiMo Code, on the managed MiMo model unless a
// provider is given) or codex (Codex CLI, on the kit account's own saved OpenAI connection:
// managed keys cover Z.ai and MiMo only). It passes when the run records the pushed
// commit as its candidate within the time limit, and fails when the checks reject that commit.
// It reports the same timing table as the agent smoke plus the sandbox's own milestones, the
// tokens the CLI reported and their cost at the registry's conservative rates, and always
// deletes the project. `agents: 2` runs one compare run instead, one managed GLM and one MiMo
// agent, each in its own sandbox: it passes only when both candidates are recorded and checked
// (eligible), and prints each agent's timing.
// `team: 'disjoint'` (`--team`): an owner-written two-task team run whose tasks touch different
// files, so both members' commits must land on the team branch through the platform's merge.
// It passes only when both members landed, the team branch candidate holds both changes and
// its checks make it eligible. `team: 'conflict'` (`--team-conflict`): two tasks rewrite the
// same line; it passes when exactly one member was resumed once after the conflict, both
// members then landed, and the team branch README.md starts with "# ".
import { readFileSync } from 'node:fs';
import { SMOKE_BRIEF, SMOKE_POLICY, SMOKE_TARGET_USD, failedCheckOutput, timeline } from './agent-smoke.mjs';
import { sleep } from './client.mjs';
import { CHEAP, bindManagedProviders, createProject, deleteProject, ensureAllowance, runFailure } from './project-flow.mjs';

const FAILED = ['failed', 'cancelled', 'needs_attention', 'awaiting_intent'];
const CLIS = ['claude', 'codex', 'opencode', 'mimo'];
const seconds = (ms) => (ms / 1000).toFixed(1);
const registry = JSON.parse(readFileSync(new URL('../../backend/crates/yoneda-agents-core/src/providers.json', import.meta.url), 'utf8'));

/**
 * The CLI's own token report (the `result` activity line) priced at the registry's rates.
 * opencode and MiMo Code report their last model step only, so their spend reads low.
 */
export function tokenSpend(provider, model, text) {
  const match = /(\d+) input \/ (\d+) output tokens/.exec(text ?? '');
  if (!match) return null;
  const [input, output] = [Number(match[1]), Number(match[2])];
  const entry = (registry.providers ?? registry).find((p) => p.id === provider)?.models.find((m) => m.id === model);
  const rates = entry?.conservative_pricing;
  if (!rates) return { input, output, usd: null };
  const usd = (input * rates.input_microusd_per_million + output * rates.output_microusd_per_million) / 1e12;
  return { input, output, usd };
}

async function activity(account, repo, executionId) {
  const entries = [];
  for (let after = 0; ; ) {
    const page = await account.get(`/api/repos/${repo}/sandbox_activity?execution_id=${encodeURIComponent(executionId)}&after=${after}`);
    entries.push(...(page.entries ?? []));
    if (!page.has_more || !page.entries?.length) return { entries, phase: page.phase };
    after = page.next;
  }
}

// Each task names the shared interface, since members never talk to each other.
const TEAMS = {
  disjoint: {
    intent: SMOKE_BRIEF.intent,
    criteria: SMOKE_BRIEF.criteria,
    policy: SMOKE_POLICY,
    paths: ['src/math.js', 'test/math.test.js'],
    tasks: [
      ['math', 'Write src/math.js', 'Create src/math.js in CommonJS: module.exports = { add }, where add(a, b) returns a + b. Another agent writes the test. Create or change no other file.'],
      ['test', 'Write test/math.test.js', "Create test/math.test.js using node:test and node:assert that loads const { add } = require('../src/math.js') and checks add(2, 3) === 5 and add(-1, 1) === 0. Another agent writes src/math.js: do not create it. Create or change no other file."],
    ],
  },
  conflict: {
    intent: 'Retitle the project: the first line of README.md is its title.',
    criteria: ['README.md starts with a level-one heading'],
    policy: {
      version: 'sandbox-team-conflict-v1',
      suite: 'commands-v1',
      environment: SMOKE_POLICY.environment,
      required_checks: ['readme'],
      build: { setup: [], checks: [{ name: 'readme', argv: ['node', '-e', "if(!/^# /.test(require('fs').readFileSync('README.md','utf8')))process.exit(1)"], timeout_seconds: 10 }], static_dir: 'public' },
    },
    paths: ['README.md'],
    tasks: [
      ['alpha', 'Title Alpha', "Replace the first line of README.md with '# Alpha'. Change no other line or file."],
      ['beta', 'Title Beta', "Replace the first line of README.md with '# Beta'. Change no other line or file."],
    ],
  },
};

/** Starts an owner-written two-task team run on the sandbox runtime; returns its id. */
async function startTeam(account, repo, agent, team, cli) {
  const id = `run-${crypto.randomUUID()}`;
  await account.post(`/api/repos/${repo}/start_run`, {
    id,
    mode: 'collaborate',
    intent: team.intent,
    criteria: team.criteria,
    context: [],
    runtime: 'sandbox-cli-v1',
    agents: [{ connection: agent.connection, provider: agent.provider, model: agent.model, strategy: 'Team member', ...(cli ? { cli } : {}) }],
    team: {
      version: 1,
      contract: team.intent,
      integrator_agent: 0,
      integration_paths: ['scopes/'],
      // The plan format wants disjoint scopes; a sandbox does not enforce them.
      tasks: team.tasks.map(([task, title, instructions]) => ({ id: task, title, instructions, agent: 0, depends_on: [], write_paths: [`scopes/${task}`] })),
    },
  });
  return id;
}

/** Each member's landing, and the problem with them when the team smoke cannot pass. */
function teamVerdict(detail, mode) {
  const members = (detail.executions ?? []).filter((e) => e.sandbox_task);
  const lines = members.map((e) => `  ${e.sandbox_task.title}: ${e.status} ${e.landing ? `${e.landing.status}${e.landing.paths ? ` on ${e.landing.paths.join(', ')}` : ''}${e.landing.resumed ? ' (resumed once)' : ''}` : 'not landed'}${e.error ? ` · ${e.error}` : ''}`);
  const resumed = members.filter((e) => e.landing?.resumed).length;
  const landed = members.filter((e) => e.landing?.status === 'landed').length;
  const problem =
    members.length !== 2
      ? `expected 2 members, found ${members.length}`
      : mode === 'conflict' && resumed !== 1
        ? `expected exactly one resumed member, found ${resumed}`
        : landed !== 2 && `expected both members landed, found ${landed}`;
  return { lines, problem, landed, resumed };
}

/** One run on the sandbox: one agent per connection, each on `cli`, no reviewer. */
async function startAgents(account, repo, agents, cli) {
  const id = `run-${crypto.randomUUID()}`;
  const requested = agents.map(({ connection }) => ({ connection, role: 'builder', ...(cli ? { cli } : {}) }));
  await account.post(`/api/repos/${repo}/start_run`, { id, mode: 'compare', ...SMOKE_BRIEF, context: [], adaptive_team: { version: 1, requested_agents: requested }, runtime: 'sandbox-cli-v1' });
  return id;
}

/**
 * The smoke's agents: the managed cheap models, or (Codex CLI) the kit account's own saved
 * OpenAI connection, since Codex speaks only the OpenAI Responses API.
 */
async function smokeAgents(account, provider, agents, cli) {
  if (cli === 'codex') {
    const { providers = [] } = await account.get('/api/settings');
    const openai = providers.find((p) => p.provider === 'codex');
    if (!openai) throw new Error('--cli codex needs an OpenAI connection saved on the kit account (managed keys cover Z.ai and MiMo only)');
    return Array.from({ length: agents }, () => ({ connection: openai.id, provider: 'codex', model: openai.model }));
  }
  const models = agents === 2 ? CHEAP.filter((c) => ['zai', 'mimo'].includes(c.provider)) : [CHEAP.find((c) => c.provider === provider)];
  return models.map((m) => ({ ...m, connection: `managed-${m.provider}` }));
}

/**
 * Polls until every agent's pushed commit is a candidate, or one cannot be (throws). A team
 * has one candidate, its team branch, which forms even when a member failed (`team`).
 */
async function waitPushed(account, repo, id, agents, timeoutMs, team = false) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await account.get(`/api/repos/${repo}/runs/${id}`);
    const candidates = (detail.candidates ?? []).filter((c) => c.revision?.commit);
    if (candidates.length >= agents) return { detail, candidates };
    const failed = !team && (detail.executions ?? []).find((e) => e.status === 'failed');
    if (FAILED.includes(detail.run.status) || failed) throw new Error(`Run ${detail.run.status}: ${runFailure(detail) || failed?.error || 'no recorded error'}`);
    if (Date.now() >= deadline) throw new Error(`${candidates.length} of ${agents} pushed commits within ${seconds(timeoutMs)} s (run ${detail.run.status})`);
    await sleep(3000);
  }
}

/** Polls the candidates' checks; a `null` status has not finished within `waitMs`. */
async function waitChecked(account, repo, id, candidateIds, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const detail = await account.get(`/api/repos/${repo}/runs/${id}`);
    const statuses = candidateIds.map((cid) => {
      const status = (detail.candidates ?? []).find((c) => c.id === cid)?.status;
      return ['evaluating', 'pending', 'queued', 'running', undefined].includes(status) ? null : status;
    });
    if (statuses.every(Boolean) || Date.now() >= deadline) return { detail, statuses };
    await sleep(5000);
  }
}

function sandboxLines(entries, startedAt) {
  const first = (kind) => entries.find((e) => e.kind === kind)?.at;
  const rel = (t) => (t ? `+${seconds(t - startedAt)} s` : '-');
  return [
    `sandbox: agent started ${rel(first('init'))}, first tool ${rel(first('tool'))}, CLI result ${rel(first('result'))}, ${entries.filter((e) => e.kind === 'tool').length} tool calls`,
    ...entries.slice(-12).map((e) => `  +${seconds(e.at - startedAt).padStart(6)} s ${e.kind} ${e.text.slice(0, 160)}`),
  ];
}

export async function sandboxSmoke({ account, owner, username, provider, agents = 1, team: mode = null, cli = null, timeoutMs = 300_000, checkWaitMs = 180_000 }, metrics) {
  if (cli && !CLIS.includes(cli)) throw new Error(`The sandbox smoke's --cli is one of ${CLIS.join(', ')}`);
  // MiMo Code smokes the MiMo model unless told otherwise; Codex CLI runs only OpenAI models.
  provider ??= cli === 'mimo' ? 'mimo' : 'zai';
  if (cli !== 'codex' && !CHEAP.some((c) => c.provider === provider)) throw new Error(`Smoke provider must be one of ${CHEAP.map((c) => c.provider).join(', ')}`);
  if (![1, 2].includes(agents)) throw new Error('The sandbox smoke takes --agents 1 or 2');
  const team = mode ? TEAMS[mode] : null;
  if (mode && !team) throw new Error(`Team smoke must be one of ${Object.keys(TEAMS).join(', ')}`);
  if (team && agents !== 1) throw new Error('A team smoke runs two tasks on one agent model: drop --agents');
  const models = await smokeAgents(account, provider, team ? 1 : agents, cli);
  Object.assign(metrics, { runtime: 'sandbox-cli-v1', cli: cli ?? 'default', agents, model: models.map((m) => `${m.provider}/${m.model}`).join(' + '), ...(mode ? { team: mode } : {}) });
  const project = await createProject(account, `sandbox-smoke-${Date.now()}`, metrics, team?.policy ?? SMOKE_POLICY);
  let failure;
  try {
    await bindManagedProviders(owner, username);
    await ensureAllowance(account, owner, username);
    const startedAt = Date.now();
    const runId = team ? await startTeam(account, project.id, models[0], team, cli) : await startAgents(account, project.id, models, cli);
    metrics.run = runId;
    // Each agent's own timing (its sandbox milestones), then the run's shared timeline.
    const report = async (detail) => {
      const lines = [await timeline(account, project.id, detail, startedAt, { verbose: false })];
      let usd = 0;
      for (const execution of detail?.executions ?? []) {
        const log = await activity(account, project.id, execution.id).catch(() => ({ entries: [] }));
        const tokens = tokenSpend(execution.provider, execution.model, log.entries.find((e) => e.kind === 'result')?.text);
        if (tokens) metrics[`tokens_${execution.provider}`] = `${tokens.input}/${tokens.output}`;
        usd += tokens?.usd ?? 0;
        const candidate = (detail.candidates ?? []).find((c) => c.execution === execution.id);
        lines.push(`${execution.id} ${execution.cli ?? 'claude'} ${execution.provider}/${execution.model}: ${execution.status}${candidate ? `, candidate ${candidate.status}${candidate.created_at ? ` at +${seconds(candidate.created_at - startedAt)} s` : ''}` : ''}`, ...sandboxLines(log.entries, startedAt));
      }
      metrics.spend_usd = usd.toFixed(4);
      metrics.spend_target = usd < SMOKE_TARGET_USD * agents ? 'met' : `over $${SMOKE_TARGET_USD * agents}`;
      if (team && detail) lines.push('team members:', ...teamVerdict(detail, mode).lines);
      return lines.join('\n');
    };
    try {
      const { candidates } = await waitPushed(account, project.id, runId, agents, timeoutMs, !!team);
      Object.assign(metrics, { pushed_s: seconds(Date.now() - startedAt), commits: candidates.map((c) => c.revision.commit.slice(0, 12)).join(' ') });
      const checked = await waitChecked(account, project.id, runId, candidates.map((c) => c.id), checkWaitMs);
      metrics.checked = checked.statuses.map((s) => s ?? `pending after ${seconds(checkWaitMs)} s`).join(', ');
      metrics.wall_s = seconds(Date.now() - startedAt);
      console.log(`Sandbox smoke timeline (run ${runId}):\n${await report(checked.detail)}`);
      if (team) {
        // The team candidate is the team branch: it must hold every member's change.
        const verdict = teamVerdict(checked.detail, mode);
        Object.assign(metrics, { landed: verdict.landed, resumed: verdict.resumed });
        if (verdict.problem) throw new Error(`Team smoke: ${verdict.problem}`);
        // The team head's own tree, read back: every task's file, and (conflict) a title line.
        const { files = {} } = await account.get(`/api/repos/${project.id}/candidate_source?id=${encodeURIComponent(candidates[0].id)}`);
        const missing = team.paths.filter((path) => typeof files[path]?.content !== 'string');
        if (missing.length) throw new Error(`The team branch lacks ${missing.join(', ')}`);
        if (mode === 'conflict' && !files['README.md'].content.startsWith('# '))
          throw new Error(`The team branch README.md does not start with "# ": ${JSON.stringify(files['README.md'].content.slice(0, 80))}`);
        if (mode === 'disjoint' && checked.statuses[0] !== 'eligible') throw new Error(`The team branch was ${checked.statuses[0] ?? 'not checked in time'}`);
      }
      // A rejected commit fails the smoke; with two agents, so does a check still pending.
      if (checked.statuses.some((s) => (agents > 1 ? s !== 'eligible' : s && s !== 'eligible')))
        throw new Error(`Not every pushed commit passed its checks: ${metrics.checked}`);
    } catch (error) {
      failure = error;
      metrics.wall_s ??= seconds(Date.now() - startedAt);
      const detail = await account.get(`/api/repos/${project.id}/runs/${runId}`).catch(() => null);
      console.error(`Sandbox smoke FAILED (run ${runId}${detail ? `, status ${detail.run.status}` : ''}): ${error.message}`);
      if (detail) {
        console.error(await report(detail));
        const checks = await failedCheckOutput(account, project.id, detail);
        if (checks) console.error(checks);
      }
      // Stop the sandbox before the project goes: a timed-out run may still be working.
      await account.post(`/api/repos/${project.id}/cancel_run`, { run_id: runId }).catch(() => {});
    }
  } finally {
    await deleteProject(account, project, {}).catch((e) => console.error(`Deleting smoke project ${project.id} failed: ${e.message}`));
  }
  if (failure) throw failure;
}
