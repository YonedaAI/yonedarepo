import { isDeepStrictEqual as equal } from 'node:util';
import { createHash } from 'node:crypto';

const fail = (message) => {
  throw new Error(message);
};
export function checkedStep(step, runs) {
  const candidates = runs.flatMap((run) => run.candidates ?? []);
  const evaluations = runs.flatMap((run) => run.evaluations ?? []);
  const candidate = candidates.find((item) => item.id === step.candidate_id);
  const evaluation = evaluations.find((item) => item.id === candidate?.evaluation);
  if (
    !candidate ||
    candidate.status !== 'eligible' ||
    !equal(candidate.revision, step.revision) ||
    !evaluation ||
    evaluation.candidate !== candidate.id ||
    !equal(evaluation.revision, candidate.revision) ||
    evaluation.policy !== 'task-board-v1' ||
    evaluation.suite !== 'commands-v1' ||
    evaluation.environment !== 'linux-node24-rust1.94-v1' ||
    !/^[a-f0-9]{64}$/.test(evaluation.evidence ?? '') ||
    evaluation.checks?.filter(
      (check) => check.name === 'guided-task-board' && check.status === 'pass',
    ).length !== 1
  )
    fail('Step lacks an independent passing evaluation bound to its exact candidate revision');
  return {
    candidate_id: candidate.id,
    revision: candidate.revision,
    evaluation_id: evaluation.id,
    evidence: evaluation.evidence,
  };
}

export async function readCheckReport(api, repo, checked, step) {
  const object = await api(`repos/${repo}/evidence?digest=${checked.evidence}`);
  if (
    object.digest !== checked.evidence ||
    typeof object.content !== 'string' ||
    object.content.length > 8 * 1024 * 1024 ||
    createHash('sha256').update(object.content).digest('hex') !== checked.evidence
  )
    fail('Protected evidence object digest differs from ledger');
  const report = JSON.parse(object.content);
  if (
    report.guided_check_phase !== (step === 'concurrent' ? 'final' : step) ||
    report.guided_check_variant != null
  )
    fail('Checked step lacks its exact frozen protected phase');
  return { digest: object.digest, report };
}

/** Owner inspection is separate from agents' recorded context access/citation receipts. */
export async function readHistoryEvidence(api, repo, runId) {
  const pages = [];
  let cursor = 0;
  for (let index = 0; index < 50; index++) {
    const page = await api(
      `repos/${repo}/context_usage?run_id=${encodeURIComponent(runId)}&limit=100&cursor=${cursor}`,
    );
    if (page.run_id !== runId || typeof page.has_more !== 'boolean')
      fail('Context receipt page belongs to a different run');
    pages.push(page);
    if (!page.has_more) break;
    if (!Number.isSafeInteger(page.next_cursor) || page.next_cursor <= cursor)
      fail('Context receipt cursor did not advance');
    cursor = page.next_cursor;
    if (index === 49) fail('Context receipt paging bound exceeded');
  }
  const citations = pages.flatMap((page) => page.citations ?? []);
  const targets = new Set(
    citations.flatMap((citation) => (citation.targets ?? []).map((target) => target.id)),
  );
  if (targets.size > 100) fail('Context citation target bound exceeded');
  const records = [];
  for (const id of targets) {
    const record = await api(`repos/${repo}/context_get?id=${encodeURIComponent(id)}`);
    if (record.id !== id) fail('Cited context record readback differs');
    records.push(record);
  }
  return {
    observer: 'owner_read_only',
    usage_pages: pages,
    cited_records: records,
    causal_effect: null,
  };
}
