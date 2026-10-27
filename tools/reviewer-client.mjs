// Metadata-only discovery and selected-run reads. Never starts or approves work.
function safeExplanation(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1024)
    : '';
}

/** Agent judgment and human selection are separate from canonical publication. */
export function comparisonSummary(run) {
  const comparison = run?.comparison;
  if (!comparison) return 'No automatic comparison review is recorded for this run.';
  const publish = run.status === 'accepted'
    ? 'Your publishing decision is already recorded; inspect publication readback in the browser.'
    : 'Publication still requires your decision in the browser.';
  if (comparison.status === 'selected') {
    if (comparison.selected_by === 'owner') {
      const history = comparison.latest_review
        ? 'The earlier agent review remains recorded.' : 'No agent comparison review has completed.';
      return `Human selection: ${safeExplanation(comparison.selection_reason) || 'recorded'}. ${history} ${publish}`;
    }
    return `Agent review completed. Agent explanation: ${safeExplanation(comparison.latest_review?.rationale) || 'inspect the recorded review in the browser'}. ${publish}`;
  }
  const stage = ['building', 'checking', 'reviewing', 'repairing', 'needs_attention', 'stale'].includes(comparison.status)
    ? comparison.status.replaceAll('_', ' ') : 'unavailable';
  return `Agent comparison: ${stage}. Inspect both results and the recorded evidence in the browser. ${publish}`;
}

export async function workspaceAllowance(api) {
  let allowance;
  try { allowance = await api('workspace/allowance'); }
  catch (error) {
    if (error?.status === 404 && error.code === 'NOT_FOUND'
        && ['Unknown API route', 'Unknown workspace operation', 'Unknown workspace allowance operation'].includes(error.message))
      return null;
    throw error;
  }
  if (!Number.isSafeInteger(allowance?.version) || allowance.version < 0
      || allowance.version >= 1 && (!Number.isSafeInteger(allowance.remaining_microusd) || allowance.remaining_microusd < 0))
    throw new Error('Invalid shared workspace allowance; open the hosted app.');
  return allowance;
}

export async function workspaceEntry(api, options) {
  const result = await api('repositories');
  if (!Array.isArray(result?.repositories)
      || result.repositories.some(repo => typeof repo.id !== 'string' || !repo.id))
    throw new Error('Invalid owned project discovery; open the hosted app.');
  const projects = result.repositories.filter(repo => repo.status === 'ready');
  const repo = projects[0];
  const entry = { repo_id: repo?.id, url: repo ? `/?repo=${encodeURIComponent(repo.id)}` : '/' };
  if (options.newTrial || options.resume)
    return { ...entry, message: '--new and --resume are legacy trial options. Open Start a Run in your ordinary workspace; describe a change and approve it in the browser. No work was started or resumed by this command.' };
  const checked = [];
  for (const project of projects) {
    const run = await findCheckedRun(api, project.id);
    if (run) checked.push({ repo_id: project.id, run });
  }
  checked.sort((left, right) => (right.run.created_at ?? 0) - (left.run.created_at ?? 0)
    || String(right.run.id).localeCompare(String(left.run.id)));
  if (checked.length) {
    const latest = checked[0];
    return { repo_id: latest.repo_id, run_id: latest.run.id,
      url: `/?repo=${encodeURIComponent(latest.repo_id)}&run=${encodeURIComponent(latest.run.id)}`,
      message: `Read-only review: opening the latest current-policy checked run in your owned projects. Candidate ${latest.run.current_checked_candidate.id}, revision ${latest.run.current_checked_candidate.revision.commit}, policy ${latest.run.current_checked_candidate.policy}. ${comparisonSummary(latest.run)} No work was started or resumed.` };
  }
  if (options.checkedOnly) throw new Error('No current-policy checked run is available in your owned projects. --checked never starts or resumes work.');
  return { ...entry, message: 'No current-policy checked run is available. Historical runs remain in the workspace. Open Start a Run to describe a change and approve it in the browser. This command starts no inference.' };
}

function isLegacyUnknownOperation(error) {
  return error?.code === 'NOT_FOUND' && error.message === 'Unknown repository operation'
    && (error.status == null || [404, 409].includes(error.status));
}

async function legacySnapshot(api, repo) {
  return api(`repos/${encodeURIComponent(repo)}/snapshot`);
}

function currentCheckedRun(detail, run) {
  const policy = detail.repository?.policy;
  if (!['ready', 'accepted'].includes(run.status)
      || !['version', 'suite', 'environment'].every(key => typeof policy?.[key] === 'string' && policy[key])
      || !Array.isArray(policy.required_checks) || !policy.required_checks.length
      || policy.required_checks.some(name => typeof name !== 'string' || !name)
      || new Set(policy.required_checks).size !== policy.required_checks.length
      || !Array.isArray(detail.candidates) || !Array.isArray(detail.evaluations)) return null;
  const selected = run.comparison?.selected_candidate_id;
  const candidates = typeof selected === 'string' && selected
    ? detail.candidates.filter(candidate => candidate.id === selected)
    : [...detail.candidates].sort((left, right) => Number(right.working_branch_state === 'checked_head') - Number(left.working_branch_state === 'checked_head'));
  for (const candidate of candidates) {
    if (candidate.run_id !== run.id || candidate.status !== 'eligible'
        || typeof candidate.id !== 'string' || !candidate.id
        || typeof candidate.evaluation !== 'string' || !candidate.evaluation
        || typeof candidate.revision?.repository !== 'string' || !candidate.revision.repository
        || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(candidate.revision?.commit ?? '')) continue;
    const matching = detail.evaluations.filter(item => item.id === candidate.evaluation);
    if (matching.length !== 1) continue;
    const evaluation = matching[0];
    if (evaluation.candidate !== candidate.id
        || evaluation.revision?.repository !== candidate.revision.repository
        || evaluation.revision?.commit !== candidate.revision.commit
        || evaluation.policy !== policy.version || evaluation.suite !== policy.suite
        || evaluation.environment !== policy.environment
        || !/^[a-f0-9]{64}$/i.test(evaluation.evidence ?? '')
        || !Array.isArray(evaluation.checks)
        || !policy.required_checks.every(name => {
          const checks = evaluation.checks.filter(check => check.name === name);
          return checks.length === 1 && checks[0].status === 'pass';
        })) continue;
    return { ...run, current_checked_candidate: {
      id: candidate.id, revision: candidate.revision, evaluation_id: evaluation.id, policy: policy.version,
    } };
  }
  return null;
}

function checkedSnapshotRun(snapshot) {
  if (!Array.isArray(snapshot?.runs))
    throw new Error('Invalid legacy reviewer snapshot; open the hosted app.');
  return snapshot.runs
    .filter(run => ['ready', 'accepted'].includes(run.status))
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0)
      || String(right.id).localeCompare(String(left.id)))
    .map(run => currentCheckedRun(snapshot, run)).find(Boolean) ?? null;
}

export async function findCheckedRun(api, repo) {
  let cursor;
  let watermark;
  const seen = new Set();
  for (;;) {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor != null) query.set('cursor', cursor);
    if (watermark != null) query.set('watermark', String(watermark));
    let page;
    try {
      page = await api(`repos/${encodeURIComponent(repo)}/runs_page?${query}`);
    } catch (error) {
      if (!isLegacyUnknownOperation(error)) throw error;
      return checkedSnapshotRun(await legacySnapshot(api, repo));
    }
    if (!Array.isArray(page.items) || !Number.isSafeInteger(page.watermark))
      throw new Error('Invalid reviewer history response; open the hosted app.');
    if (watermark != null && watermark !== page.watermark)
      throw new Error('Reviewer history changed while paging; retry.');
    for (const run of page.items.filter(item => ['ready', 'accepted'].includes(item.status))) {
      const detail = await readRun(api, repo, run.id);
      const checked = currentCheckedRun(detail, { ...run, ...detail.runs[0] });
      if (checked) return checked;
    }
    if (page.next_cursor == null) return null;
    if (typeof page.next_cursor !== 'string' || !page.next_cursor || seen.has(page.next_cursor))
      throw new Error('Invalid reviewer history cursor; open the hosted app.');
    watermark = page.watermark;
    cursor = page.next_cursor;
    seen.add(cursor);
  }
}

export async function readRun(api, repo, runId) {
  let detail;
  try {
    detail = await api(`repos/${encodeURIComponent(repo)}/run_detail?run_id=${encodeURIComponent(runId)}`);
  } catch (error) {
    if (!isLegacyUnknownOperation(error)) throw error;
    const snapshot = await legacySnapshot(api, repo);
    if (!Array.isArray(snapshot?.runs) || !Array.isArray(snapshot.executions))
      throw new Error('Invalid legacy reviewer snapshot; open the hosted app.');
    const run = snapshot.runs.find(item => item.id === runId);
    if (!run) throw new Error('The selected run is not present in the legacy snapshot.');
    detail = {
      ...snapshot,
      runs: [run],
      executions: snapshot.executions.filter(item => item.run_id === runId),
      nodes: [],
      edges: [],
      graph_paged: true,
    };
    for (const key of ['team_tasks', 'team_handoffs', 'candidates', 'decisions', 'artifacts'])
      if (Array.isArray(snapshot[key])) detail[key] = snapshot[key].filter(item => item.run_id === runId);
    const candidateIds = new Set(detail.candidates?.map(candidate => candidate.id));
    if (Array.isArray(snapshot.evaluations))
      detail.evaluations = snapshot.evaluations.filter(item => candidateIds.has(item.candidate));
  }
  if (!Array.isArray(detail.runs) || !Array.isArray(detail.executions)
      || detail.runs.length !== 1 || detail.runs[0].id !== runId
      || detail.executions.some(execution => execution.run_id !== runId))
    throw new Error('The response did not identify the selected run; open the hosted app.');
  return detail;
}
