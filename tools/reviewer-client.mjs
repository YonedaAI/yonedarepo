// Metadata-only discovery and selected-run reads. Never starts or approves work.
export async function findCheckedRun(api, repo) {
  let cursor;
  let watermark;
  const seen = new Set();
  for (;;) {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor != null) query.set('cursor', cursor);
    if (watermark != null) query.set('watermark', String(watermark));
    const page = await api(`repos/${encodeURIComponent(repo)}/runs_page?${query}`);
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
  const detail = await api(`repos/${encodeURIComponent(repo)}/run_detail?run_id=${encodeURIComponent(runId)}`);
  if (!Array.isArray(detail.runs) || !Array.isArray(detail.executions)
      || detail.runs.length !== 1 || detail.runs[0].id !== runId
      || detail.executions.some(execution => execution.run_id !== runId))
    throw new Error('The response did not identify the selected run; open the hosted app.');
  return detail;
}
