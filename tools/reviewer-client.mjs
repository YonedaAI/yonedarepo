// Metadata-only discovery and selected-run reads. Never starts or approves work.
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
      message: 'Read-only review: opening the latest recorded checked run in your owned projects. No work was started or resumed.' };
  }
  if (options.checkedOnly) throw new Error('No recorded checked run is available in your owned projects. --checked never starts or resumes work.');
  return { ...entry, message: 'No checked run is available yet. Open Start a Run in your ordinary workspace; describe a change and approve it in the browser. This command starts no inference.' };
}

export async function campaignEntry(api, campaign, newTrial, requestId, resume = false) {
  if (!campaign.enabled) throw new Error('The fresh campaign is not ready for review yet.');
  if (resume) {
    if (!campaign.active_trial) throw new Error('No campaign trial to resume.');
    return api('reviewer/campaign/resume', {});
  }
  if (!newTrial) {
    const checked = await api('reviewer/campaign/checked');
    if (!checked) throw new Error('No checked app is ready yet. This command does not start work.');
    return checked;
  }
  if (campaign.active_trial) {
    return {repo_id:campaign.repo_id,run_id:campaign.active_trial,
      url:`/?repo=${encodeURIComponent(campaign.repo_id)}&run=${encodeURIComponent(campaign.active_trial)}`};
  }
  return api('reviewer/campaign/trial',{request_id:requestId});
}
function isLegacyUnknownOperation(error) {
  return error?.code === 'NOT_FOUND' && error.message === 'Unknown repository operation';
}

async function legacySnapshot(api, repo) {
  return api(`repos/${encodeURIComponent(repo)}/snapshot`);
}

function checkedSnapshotRun(snapshot) {
  if (!Array.isArray(snapshot?.runs))
    throw new Error('Invalid legacy reviewer snapshot; open the hosted app.');
  return snapshot.runs
    .filter(run => ['ready', 'accepted'].includes(run.status))
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0)
      || String(right.id).localeCompare(String(left.id)))[0] ?? null;
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
    const checked = page.items.find(run => ['ready', 'accepted'].includes(run.status));
    if (checked) return checked;
    if (page.next_cursor == null) return null;
    if (typeof page.next_cursor !== 'string' || !page.next_cursor || seen.has(page.next_cursor))
      throw new Error('Invalid reviewer history cursor; open the hosted app.');
    if (watermark != null && watermark !== page.watermark)
      throw new Error('Reviewer history changed while paging; retry.');
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
    for (const key of ['team_tasks', 'team_handoffs', 'candidates', 'evaluations', 'decisions', 'artifacts'])
      if (Array.isArray(snapshot[key])) detail[key] = snapshot[key].filter(item => item.run_id === runId);
  }
  if (!Array.isArray(detail.runs) || !Array.isArray(detail.executions)
      || detail.runs.length !== 1 || detail.runs[0].id !== runId
      || detail.executions.some(execution => execution.run_id !== runId))
    throw new Error('The response did not identify the selected run; open the hosted app.');
  return detail;
}
