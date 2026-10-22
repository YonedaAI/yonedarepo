// Sandbox smoke: the agent smoke's brief and policy on runtime `sandbox-cli-v1` (Claude Code in
// a Cloudflare Sandbox, cheap managed GLM or MiMo). It passes when the run records the pushed
// commit as its candidate within the time limit, and fails when the checks reject that commit.
// It reports the same timing table as the agent smoke plus the sandbox's own milestones, the
// tokens the CLI reported and their cost at the registry's conservative rates, and always
// deletes the project.
import { readFileSync } from 'node:fs';
import { SMOKE_POLICY, SMOKE_TARGET_USD, startSingle, timeline } from './agent-smoke.mjs';
import { sleep } from './client.mjs';
import { CHEAP, bindManagedProviders, createProject, deleteProject, ensureAllowance, runFailure } from './project-flow.mjs';

const FAILED = ['failed', 'cancelled', 'needs_attention', 'awaiting_intent'];
const seconds = (ms) => (ms / 1000).toFixed(1);
const registry = JSON.parse(readFileSync(new URL('../../backend/crates/yoneda-agents-core/src/providers.json', import.meta.url), 'utf8'));

/** The CLI's own token report (the `result` activity line) priced at the registry's rates. */
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

/** Polls until the run records a candidate (the pushed commit) or cannot (throws). */
async function waitPushed(account, repo, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await account.get(`/api/repos/${repo}/runs/${id}`);
    const candidate = (detail.candidates ?? []).find((c) => c.revision?.commit);
    if (candidate) return { detail, candidate };
    if (FAILED.includes(detail.run.status)) throw new Error(`Run ${detail.run.status}: ${runFailure(detail) || 'no recorded error'}`);
    if (Date.now() >= deadline) throw new Error(`No pushed commit within ${seconds(timeoutMs)} s (run ${detail.run.status})`);
    await sleep(3000);
  }
}

/** Polls the candidate's checks; `null` when they have not finished within `waitMs`. */
async function waitChecked(account, repo, id, candidateId, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const detail = await account.get(`/api/repos/${repo}/runs/${id}`);
    const candidate = (detail.candidates ?? []).find((c) => c.id === candidateId);
    if (candidate && !['evaluating', 'pending', 'queued', 'running'].includes(candidate.status)) return { detail, status: candidate.status };
    if (Date.now() >= deadline) return { detail, status: null };
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

export async function sandboxSmoke({ account, owner, username, provider = 'zai', timeoutMs = 300_000, checkWaitMs = 180_000 }, metrics) {
  const cheap = CHEAP.find((c) => c.provider === provider);
  if (!cheap) throw new Error(`Smoke provider must be one of ${CHEAP.map((c) => c.provider).join(', ')}`);
  Object.assign(metrics, { runtime: 'sandbox-cli-v1', model: `${provider}/${cheap.model}` });
  const project = await createProject(account, `sandbox-smoke-${Date.now()}`, metrics, SMOKE_POLICY);
  let failure;
  try {
    await bindManagedProviders(owner, username);
    await ensureAllowance(account, owner, username);
    const startedAt = Date.now();
    const runId = await startSingle(account, project.id, provider, 'sandbox-cli-v1');
    metrics.run = runId;
    const report = async (detail) => {
      const execution = detail?.executions?.[0];
      const log = execution ? await activity(account, project.id, execution.id).catch(() => ({ entries: [] })) : { entries: [] };
      const tokens = tokenSpend(provider, cheap.model, log.entries.find((e) => e.kind === 'result')?.text);
      if (tokens) metrics.tokens = `${tokens.input}/${tokens.output}`;
      if (tokens?.usd != null) metrics.spend_usd = tokens.usd.toFixed(4);
      if (tokens?.usd != null) metrics.spend_target = tokens.usd < SMOKE_TARGET_USD ? 'met' : `over $${SMOKE_TARGET_USD}`;
      return [await timeline(account, project.id, detail, startedAt, { verbose: false }), ...sandboxLines(log.entries, startedAt)].join('\n');
    };
    try {
      const { candidate } = await waitPushed(account, project.id, runId, timeoutMs);
      Object.assign(metrics, { pushed_s: seconds(Date.now() - startedAt), commit: candidate.revision.commit.slice(0, 12) });
      const checked = await waitChecked(account, project.id, runId, candidate.id, checkWaitMs);
      metrics.checked = checked.status ?? `pending after ${seconds(checkWaitMs)} s`;
      metrics.wall_s = seconds(Date.now() - startedAt);
      console.log(`Sandbox smoke timeline (run ${runId}):\n${await report(checked.detail)}`);
      if (checked.status && checked.status !== 'eligible') throw new Error(`The pushed commit was ${checked.status} by its checks`);
    } catch (error) {
      failure = error;
      metrics.wall_s ??= seconds(Date.now() - startedAt);
      const detail = await account.get(`/api/repos/${project.id}/runs/${runId}`).catch(() => null);
      console.error(`Sandbox smoke FAILED (run ${runId}${detail ? `, status ${detail.run.status}` : ''}): ${error.message}`);
      if (detail) console.error(await report(detail));
      // Stop the sandbox before the project goes: a timed-out run may still be working.
      await account.post(`/api/repos/${project.id}/cancel_run`, { run_id: runId }).catch(() => {});
    }
  } finally {
    await deleteProject(account, project, {}).catch((e) => console.error(`Deleting smoke project ${project.id} failed: ${e.message}`));
  }
  if (failure) throw failure;
}
