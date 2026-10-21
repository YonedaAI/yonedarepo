// Agent-layer items of the staging kit, as the browser does them: create a project, run
// two-builder compares with cheap real models, publish a selected result fast-forward only
// with readback, refresh another run's pick onto the new main and publish it, and delete a
// project.
import assert from 'node:assert/strict';
import { requestId, until } from './client.mjs';

/** Cheap builders only; GLM runs at low effort by default (model-reasoning.ts). */
export const CHEAP = [
  { provider: 'zai', model: 'glm-5.3-flash' },
  { provider: 'mimo', model: 'mimo-v2.6-flash' },
];
const TERMINAL = ['selected', 'needs_attention', 'stale'];

/** Binds the deployment's Secrets Store keys to the kit account as managed connections. */
export async function bindManagedProviders(owner, username) {
  for (const { provider, model } of CHEAP) await owner.post('/api/admin/providers/managed', { username, provider, model });
}

/** Funds a person's staging account (owner only): managed cheap models and a $5 allowance. */
export async function fundAccount(owner, username) {
  await bindManagedProviders(owner, username);
  const set = await owner.raw('POST', '/api/admin/workspace/allowance', { username, expected_version: 0, limit_microusd: 5_000_000 });
  // A first configuration expects version 0; an already funded account keeps its allowance.
  if (!set.ok && set.body?.error?.code !== 'STALE_VERSION') throw new Error(`Allowance: ${set.body?.error?.code} ${set.body?.error?.message ?? ''}`);
  return set.ok ? set.body : { already_funded: true };
}

/** Gives the kit account the staging allowance ($5 total) if it has none yet. */
export async function ensureAllowance(account, owner, username, limit = 5_000_000) {
  const current = await account.get('/api/workspace/allowance');
  if (current.version >= 1 && current.limit_microusd >= limit) return current;
  return owner.post('/api/admin/workspace/allowance', { username, expected_version: current.version, limit_microusd: limit });
}

/** Creates a project like the "New project" form and waits until it is ready. */
export async function createProject(account, name, metrics) {
  const started = performance.now();
  const created = await account.post('/api/projects', { request_id: requestId('kit'), name });
  const project = await until(
    async () => {
      const p = await account.get(`/api/projects/${created.id}`);
      assert.notEqual(p.status, 'failed', `Project failed: ${p.error_code} ${p.error ?? ''}`);
      return p.status === 'ready' && p;
    },
    { timeoutMs: 300_000, what: 'project ready' },
  );
  metrics.project_ready_s = ((performance.now() - started) / 1000).toFixed(1);
  assert.match(project.platform?.repo ?? '', /^r[0-9a-f]{20}$/, 'Project has no platform repository');
  return project;
}

const snapshot = (account, repo) => account.get(`/api/repos/${repo}/snapshot`);

/** Two briefs on different files, so B's result refreshes onto A's published main cleanly. */
export const BRIEFS = {
  a: { intent: 'Add a footer to the home page that reads "Staged on dev.yonedarepo.com".', criteria: ['The footer text is visible on the home page', 'Existing content is unchanged'] },
  b: { intent: 'Create docs/about.md with two sentences describing this website. Do not modify any other file.', criteria: ['docs/about.md exists with two sentences', 'No other file changes'] },
};

/** Starts a compare run with the cheap managed builders; returns its id. */
export async function startCompare(account, repo, brief = BRIEFS.a) {
  const id = `run-${crypto.randomUUID()}`;
  await account.post(`/api/repos/${repo}/start_run`, {
    id,
    mode: 'compare',
    ...brief,
    context: [],
    adaptive_team: { version: 1, requested_agents: CHEAP.map((c) => ({ connection: `managed-${c.provider}`, role: 'auto' })) },
    comparison: { version: 1 },
  });
  return id;
}

/** Waits for a compare run's agents' pick; spend and outcome land in `metrics`. */
export async function waitCompare(account, repo, id, metrics) {
  const run = await until(
    async () => {
      const detail = await account.get(`/api/repos/${repo}/runs/${id}`);
      const { run } = detail;
      metrics.spend_usd = spend(run).toFixed(4);
      if (['failed', 'cancelled'].includes(run.status)) throw new Error(`Run ${run.status}: ${runFailure(detail)}`);
      return TERMINAL.includes(run.comparison?.status) && run;
    },
    { timeoutMs: 40 * 60_000, intervalMs: 10_000, what: 'compare run review' },
  );
  metrics.run = run.id;
  metrics.comparison = run.comparison.status;
  metrics.spend_usd = spend(run).toFixed(4);
  return run;
}

/** Why a run failed: its own error, else each failed execution's and job's error. */
function runFailure({ run, executions = [] }) {
  const parts = [run.error?.message ?? run.error, run.comparison?.status && `comparison ${run.comparison.status}`];
  for (const e of executions.filter((e) => ['failed', 'cancelled'].includes(e.status)))
    parts.push(`${e.id} ${e.role ?? ''} ${e.provider ?? ''}/${e.model ?? ''}: ${e.error ?? e.failure ?? e.status}`);
  return parts.filter(Boolean).join('; ').slice(0, 600);
}

/** Charged model spend of a run, in USD, from its frozen per-model budgets. */
export const spend = (run) => (run.model_budgets ?? []).reduce((sum, b) => sum + Number(b.charged_microusd ?? 0), 0) / 1e6;

/** The selected candidate, selecting a checked one first when the reviewer needed attention. */
async function selectedCandidate(account, repo, run) {
  if (run.comparison.status === 'selected') return run.comparison.selected_candidate_id;
  const snap = await snapshot(account, repo);
  const eligible = snap.candidates.filter((c) => c.run_id === run.id && c.status === 'eligible');
  assert.ok(eligible.length, `No checked result to select (comparison ${run.comparison.status})`);
  await account.post(`/api/repos/${repo}/select_comparison_candidate`, {
    run_id: run.id,
    request_id: requestId('select'),
    candidate_id: eligible[0].id,
    reason: 'Staging kit: first checked result',
    expected_commit: snap.repository.head_commit,
    expected_version: snap.repository.version,
    expected_policy_version: snap.repository.policy?.version,
    expected_selection_version: run.comparison.selection_version ?? 0,
  });
  return eligible[0].id;
}

/** Owner accept → approve → fast-forward land → readback; verifies main on the platform. */
export async function publish(account, repo, run, metrics, chosen) {
  const candidate = chosen ?? (await selectedCandidate(account, repo, run));
  const snap = await snapshot(account, repo);
  const decision = await account.post(`/api/repos/${repo}/accept`, {
    request_id: requestId('accept'),
    candidate,
    expected_commit: snap.repository.head_commit,
    expected_version: snap.repository.version,
    rationale: 'Staging kit publication',
  });
  const { platform_repo, ref, commit } = decision.publication;
  const platform = `/api/v1/repos/${platform_repo}`;
  const approved = await account.raw('POST', `${platform}/commits/${commit}/reviews`, { decision: 'approve' });
  assert.ok(approved.ok || approved.body?.error?.code === 'ALREADY_EXISTS', `Approve: ${approved.body?.error?.code}`);
  const started = performance.now();
  await account.post(`${platform}/land`, { ref, commit, fast_forward_only: true });
  metrics.land_ms = Math.round(performance.now() - started);
  const readback = await account.post(`/api/repos/${repo}/publication_readback`, { decision_id: decision.id });
  assert.equal(readback.status ?? readback.decision?.status, 'published', 'Readback did not record publication');
  // Batched landing may project main as its own commit; readback is the authority.
  metrics.main_is_candidate = (await account.get(`${platform}/refs`)).refs['refs/heads/main'] === commit;
  const after = await snapshot(account, repo);
  assert.equal(after.repository.published_commit, commit, 'Snapshot does not show the published commit');
  return { candidate, commit, platform_repo };
}

/**
 * N8 step 12: refresh run B's pick (built on the old main) onto the main A just published,
 * then publish the refreshed result. A compare run publishes only its selected result, so the
 * owner first selects the refreshed one when the ledger asks for it.
 */
export async function refreshMerge(account, repo, runB, metrics) {
  const { run } = await account.get(`/api/repos/${repo}/runs/${runB.id}`);
  const picked = run.comparison?.selected_candidate_id;
  assert.ok(picked, `Run B has no selected result (comparison ${run.comparison?.status})`);
  const snap = await snapshot(account, repo);
  const started = performance.now();
  const refresh = await account.post(`/api/repos/${repo}/refresh_candidate`, {
    request_id: requestId('refresh'),
    candidate_id: picked,
    expected_commit: snap.repository.head_commit,
    expected_version: snap.repository.version,
  });
  const settled = await until(
    async () => {
      // The inventory (no conflict_id) folds the refreshed result's evaluation into status.
      const { conflicts = [] } = await account.get(`/api/repos/${repo}/conflict_status`);
      const conflict = conflicts.find((c) => c.id === refresh.conflict_id);
      return conflict && !['refreshing', 'running', 'resolving', 'evaluating'].includes(conflict.status) && conflict;
    },
    { timeoutMs: 15 * 60_000, intervalMs: 5000, what: 'refresh' },
  );
  metrics.refresh = settled.status;
  metrics.refresh_s = ((performance.now() - started) / 1000).toFixed(1);
  const why = settled.error ?? settled.detail ?? settled.reason ?? settled.evaluation_status ?? '';
  assert.ok(['clean', 'done'].includes(settled.status), `Refresh ended ${settled.status} ${JSON.stringify(why).slice(0, 300)}`);
  const refreshed = settled.refreshed_candidate_id;
  assert.ok(refreshed, 'Clean refresh named no refreshed result');
  let published;
  try {
    published = await publish(account, repo, run, metrics, refreshed);
  } catch (error) {
    if (error.code !== 'COMPARISON_NOT_SELECTED') throw error;
    const now = await snapshot(account, repo);
    await account.post(`/api/repos/${repo}/select_comparison_candidate`, {
      run_id: run.id,
      request_id: requestId('select'),
      candidate_id: refreshed,
      reason: 'Staging kit: refreshed pick on the new main',
      expected_commit: now.repository.head_commit,
      expected_version: now.repository.version,
      expected_policy_version: now.repository.policy?.version,
      expected_selection_version: run.comparison.selection_version ?? 0,
    });
    metrics.reselected = true;
    published = await publish(account, repo, run, metrics, refreshed);
  }
  metrics.published_b = published.commit.slice(0, 12);
}

/** Deletes a project and checks its platform agent token is revoked. */
export async function deleteProject(account, project, metrics) {
  await account.post(`/api/repos/${project.id}/delete_repository`, { confirm_name: project.name });
  const gone = await account.raw('GET', `/api/projects/${project.id}`);
  assert.equal(gone.status, 410, 'Deleted project is still served');
  const tokens = await account.get(`/api/v1/repos/${project.platform.repo}/tokens`);
  const agent = (tokens.tokens ?? []).find((t) => t.name === 'yoneda-agents');
  assert.ok(agent?.revoked_at, 'Project agent token was not revoked');
  metrics.token_revoked = true;
}
