// Metadata-only discovery and selected-run reads. Never starts or approves work.
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
