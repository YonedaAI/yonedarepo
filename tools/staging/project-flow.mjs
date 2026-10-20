// Agent-layer items of the staging kit, as the browser does them: create a project, run a
// two-builder compare with cheap real models, publish the selected result fast-forward only
// with readback, refresh the other result onto the new main, and delete a project.
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

/** Starts a compare run and waits for the agents' pick (or needs-attention). */
export async function compareRun(account, repo, metrics) {
  const id = `run-${crypto.randomUUID()}`;
  await account.post(`/api/repos/${repo}/start_run`, {
    id,
    mode: 'compare',
    intent: 'Add a footer to the home page that reads "Staged on dev.yonedarepo.com".',
    criteria: ['The footer text is visible on the home page', 'Existing content is unchanged'],
    context: [],
    adaptive_team: { version: 1, requested_agents: CHEAP.map((c) => ({ connection: `managed-${c.provider}`, role: 'auto' })) },
    comparison: { version: 1 },
  });
  const run = await until(
    async () => {
      const { run } = await account.get(`/api/repos/${repo}/runs/${id}`);
      assert.ok(!['failed', 'cancelled'].includes(run.status), `Run ${run.status}: ${run.error ?? ''}`);
      return TERMINAL.includes(run.comparison?.status) && run;
    },
    { timeoutMs: 40 * 60_000, intervalMs: 10_000, what: 'compare run review' },
  );
  metrics.comparison = run.comparison.status;
  metrics.spend_usd = spend(run).toFixed(4);
  return run;
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
export async function publish(account, repo, run, metrics) {
  const candidate = await selectedCandidate(account, repo, run);
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
  const refs = await account.get(`${platform}/refs`);
  assert.equal(refs.refs['refs/heads/main'], commit, 'Platform main is not the published commit');
  const after = await snapshot(account, repo);
  assert.equal(after.repository.published_commit, commit);
  return { candidate, commit, platform_repo };
}

/** Refreshes the unpublished result onto the new main (platform merge, no model). */
export async function refreshOther(account, repo, run, published, metrics) {
  const snap = await snapshot(account, repo);
  const other = snap.candidates.find((c) => c.run_id === run.id && c.id !== published.candidate && ['eligible', 'rejected'].includes(c.status));
  if (!other) return { skip: 'No second checked result to refresh' };
  const started = performance.now();
  const refresh = await account.post(`/api/repos/${repo}/refresh_candidate`, {
    request_id: requestId('refresh'),
    candidate_id: other.id,
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
  assert.ok(['clean', 'done'].includes(settled.status), `Refresh ended ${settled.status}`);
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
