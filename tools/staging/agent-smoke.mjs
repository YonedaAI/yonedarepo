// Agent smoke: proves hosted agents run after a deploy. One cheap managed agent (single-agent
// run: no compare, no team) gets one tiny brief on a fresh project whose policy checks exactly
// that brief; the smoke passes when the run records a checked (eligible) candidate. It reports
// wall time, model requests and spend, prints the run's failure, execution log tail and any
// activity events when it fails, and always deletes the project.
import assert from 'node:assert/strict';
import { sleep } from './client.mjs';
import { CHEAP, bindManagedProviders, createProject, deleteProject, ensureAllowance, runFailure, spend } from './project-flow.mjs';

/** Checks that pass only when the brief is done: `add(2, 3) === 5` and the named test file passes. */
export const SMOKE_POLICY = {
  version: 'agent-smoke-v1',
  suite: 'commands-v1',
  environment: 'linux-node24-rust1.94-v1',
  required_checks: ['math', 'test'],
  build: {
    setup: [],
    checks: [
      {
        name: 'math',
        // require() also loads an ES module file on Node 24, so either module style passes.
        argv: [
          'node',
          '-e',
          "const m=require('./src/math.js');const add=typeof m==='function'?m:(m.add??m.default?.add);if(typeof add!=='function'||add(2,3)!==5||add(-1,1)!==0)process.exit(1)",
        ],
        timeout_seconds: 10,
      },
      // A named file: `node --test` with no matching file exits 0, a missing named file exits 1.
      { name: 'test', argv: ['node', '--test', 'test/math.test.js'], timeout_seconds: 30 },
    ],
    static_dir: 'public',
  },
};
export const SMOKE_BRIEF = {
  intent:
    'Create src/math.js exporting a function add(a, b) that returns a + b, and a test file test/math.test.js that checks add with node:test and node:assert. Do not change any other file.',
  criteria: ['src/math.js exports add(a, b) returning a + b', 'node --test test/math.test.js passes'],
};
export const SMOKE_TARGET_USD = 0.01;
const FAILED = ['failed', 'cancelled', 'needs_attention', 'awaiting_intent'];
const UNSETTLED_CANDIDATE = ['pending', 'capturing', 'evaluating', 'queued', 'running'];
const seconds = (ms) => (ms / 1000).toFixed(1);

/** Starts a single-agent run on one managed connection (`runtime`: sandbox-cli-v1); returns its id. */
export async function startSingle(account, repo, provider, runtime) {
  const id = `run-${crypto.randomUUID()}`;
  await account.post(`/api/repos/${repo}/start_run`, {
    id,
    // `compare` without a comparison block and with one agent is the plain single-agent run;
    // any other mode is a coordinated team run.
    mode: 'compare',
    ...SMOKE_BRIEF,
    context: [],
    adaptive_team: { version: 1, requested_agents: [{ connection: `managed-${provider}`, role: 'builder' }] },
    ...(runtime ? { runtime } : {}),
  });
  return id;
}

/** Polls the run until a candidate is eligible (pass) or the run cannot produce one (throws). */
async function waitChecked(account, repo, id, metrics, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await account.get(`/api/repos/${repo}/runs/${id}`);
    const { run, candidates = [] } = detail;
    metrics.requests = run.model_requests ?? 0;
    metrics.spend_usd = spend(run).toFixed(4);
    metrics.status = run.status;
    const checked = candidates.find((c) => c.status === 'eligible');
    if (checked) return { detail, candidate: checked };
    if (FAILED.includes(run.status)) throw new Error(`Run ${run.status}: ${runFailure(detail) || 'no recorded error'}`);
    const settled = candidates.length && candidates.every((c) => !UNSETTLED_CANDIDATE.includes(c.status));
    if (run.status === 'ready' && settled)
      throw new Error(`Run ready without a checked candidate: ${candidates.map((c) => `${c.id} ${c.status}`).join(', ')}`);
    if (Date.now() >= deadline) throw new Error(`No checked candidate within ${seconds(timeoutMs)} s (run ${run.status}, candidates: ${candidates.map((c) => c.status).join(', ') || 'none'})`);
    await sleep(5000);
  }
}

/** Every execution log entry of one execution (pages of 100). */
async function executionLogs(account, repo, executionId) {
  const entries = [];
  for (let after = 0; ; ) {
    const page = await account.get(`/api/repos/${repo}/execution_logs?execution_id=${encodeURIComponent(executionId)}&after=${after}`);
    entries.push(...(page.entries ?? []));
    if (!page.has_more || !page.entries?.length) return entries;
    after = page.next;
  }
}
const isActivity = (entry) => String(entry.data?.stage ?? '').startsWith('activity') || entry.data?.kind === 'activity';
const logLine = (start, { at, data = {} }) =>
  `  +${seconds(at - start).padStart(6)} s ${data.stage ?? data.kind ?? '?'}${data.request_number !== undefined ? ` #${data.request_number}` : ''}${data.http_status !== undefined ? ` HTTP ${data.http_status}` : ''}${data.duration_ms !== undefined ? ` ${data.duration_ms} ms` : ''}${data.error_code ? ` ${data.error_code}` : ''}${data.summary || data.message ? ` ${String(data.summary ?? data.message).slice(0, 160)}` : ''}`;

/** Where the time went: per execution, claim -> first request -> completion, from its log. */
export async function timeline(account, repo, detail, startedAt, { verbose }) {
  const lines = [];
  for (const execution of detail.executions ?? []) {
    const entries = await executionLogs(account, repo, execution.id).catch((e) => {
      lines.push(`  ${execution.id}: logs unavailable (${e.message})`);
      return [];
    });
    const at = (stage) => entries.find((e) => e.data?.stage === stage)?.at;
    const rel = (t) => (t ? `+${seconds(t - startedAt)} s` : '-');
    lines.push(
      `${execution.id} ${execution.provider ?? ''}/${execution.model ?? ''} ${execution.status}: claimed ${rel(at('execution.started'))}, first request ${rel(at('model.request_started'))}, completion ${rel(at('execution.completion_received') ?? at('execution.failure_received'))}, ${entries.filter((e) => e.data?.stage === 'model.request_started').length} requests logged`,
    );
    // A live execution's `error` is its last progress note, not a failure.
    if (execution.status === 'failed')
      lines.push(`  error:${JSON.stringify({ error: execution.error, error_code: execution.error_code, failure_stage: execution.failure_stage }).slice(0, 600)}`);
    if (verbose) {
      lines.push('  last log entries:', ...(entries.filter((e) => !isActivity(e)).slice(-15).map((e) => logLine(startedAt, e))));
      const activity = entries.filter(isActivity);
      lines.push(activity.length ? '  activity events:' : '  activity events: none recorded', ...activity.slice(-20).map((e) => logLine(startedAt, e)));
    }
  }
  for (const candidate of detail.candidates ?? []) lines.push(`candidate ${candidate.id}: ${candidate.status}${candidate.created_at ? ` at +${seconds(candidate.created_at - startedAt)} s` : ''}`);
  for (const evaluation of detail.evaluations ?? [])
    lines.push(`evaluation ${evaluation.id}: ${evaluation.status ?? ''} ${(evaluation.checks ?? []).map((c) => `${c.name}=${c.status}`).join(' ')}`);
  return lines.join('\n');
}

/**
 * The smoke: fresh project, managed connections and allowance, one single-agent run, wait for a
 * checked candidate, report, delete. `metrics` gets wall time, requests and spend either way.
 */
export async function agentSmoke({ account, owner, username, provider = 'zai', timeoutMs = 360_000 }, metrics) {
  assert.ok(
    CHEAP.some((c) => c.provider === provider),
    `Smoke provider must be one of ${CHEAP.map((c) => c.provider).join(', ')}`,
  );
  metrics.model = `${provider}/${CHEAP.find((c) => c.provider === provider).model}`;
  const project = await createProject(account, `smoke-${Date.now()}`, metrics, SMOKE_POLICY);
  let failure;
  let runId;
  let startedAt;
  try {
    await bindManagedProviders(owner, username);
    await ensureAllowance(account, owner, username);
    startedAt = Date.now();
    runId = await startSingle(account, project.id, provider);
    metrics.run = runId;
    try {
      const { detail, candidate } = await waitChecked(account, project.id, runId, metrics, timeoutMs);
      metrics.wall_s = seconds(Date.now() - startedAt);
      metrics.candidate = candidate.id;
      // Settled spend: read once more after the candidate, before the project is deleted.
      const { run } = await account.get(`/api/repos/${project.id}/runs/${runId}`);
      Object.assign(metrics, { requests: run.model_requests ?? 0, spend_usd: spend(run).toFixed(4) });
      metrics.spend_target = Number(metrics.spend_usd) < SMOKE_TARGET_USD ? 'met' : `over $${SMOKE_TARGET_USD}`;
      console.log(`Agent smoke timeline (run ${runId}):\n${await timeline(account, project.id, detail, startedAt, { verbose: false })}`);
    } catch (error) {
      failure = error;
      metrics.wall_s = seconds(Date.now() - startedAt);
      const detail = await account.get(`/api/repos/${project.id}/runs/${runId}`).catch(() => null);
      if (detail) {
        Object.assign(metrics, { requests: detail.run.model_requests ?? 0, spend_usd: spend(detail.run).toFixed(4) });
        console.error(`Agent smoke FAILED (run ${runId}, status ${detail.run.status}): ${error.message}`);
        if (detail.run.error) console.error(`Run error: ${JSON.stringify(detail.run.error).slice(0, 600)}`);
        console.error(await timeline(account, project.id, detail, startedAt, { verbose: true }));
      }
      // Stop spending before the project goes: a timed-out run may still be working.
      await account.post(`/api/repos/${project.id}/cancel_run`, { run_id: runId }).catch(() => {});
    }
  } finally {
    await deleteProject(account, project, {}).catch((e) => console.error(`Deleting smoke project ${project.id} failed: ${e.message}`));
  }
  if (failure) throw failure;
}
