import type { SourceFileTrail, SourceRevision, SourceSelection } from '../../lib/sourceWorkspace';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function revision(value: unknown): SourceRevision | undefined {
  if (!record(value) || typeof value.repository !== 'string' || !hex(value.commit)) return;
  return {
    repository: value.repository,
    commit: value.commit,
    ...(hex(value.tree) ? { tree: value.tree } : {}),
  };
}
/** Attribution, agent assertions, owner decisions and historical evaluations retain separate meaning. */
export function parseSourceProvenance(
  source: SourceSelection,
  path: string,
  value: Record<string, unknown>,
): SourceFileTrail {
  const trail: SourceFileTrail = {
    source,
    path,
    coverage: 'unknown',
    checks: [],
    risks: [],
    revisions: [],
    context: [],
  };
  if (value.provenance_authority !== 'recorded_file_provenance' || source.kind === 'proposed')
    return trail;
  const lineage = Array.isArray(value.lineage)
    ? value.lineage
        .slice(0, 128)
        .filter(record)
        .filter(
          (row) =>
            row.authority === 'trusted_capture' &&
            typeof row.id === 'string' &&
            hex(row.commit) &&
            typeof row.path === 'string' &&
            typeof row.change === 'string',
        )
    : [];
  trail.coverage = value.coverage === 'recorded' && lineage.length > 0 ? 'recorded' : 'unknown';
  trail.capture_receipts = lineage.map((row) => ({
    id: String(row.id),
    commit: String(row.commit),
    path: String(row.path),
    change: String(row.change),
    ...(typeof row.capture_epoch === 'number' && Number.isSafeInteger(row.capture_epoch)
      ? { capture_epoch: row.capture_epoch }
      : {}),
  }));
  trail.reasons = lineage
    .filter((row) => typeof row.candidate_summary === 'string' && row.candidate_summary.trim())
    .map((row) => ({
      id: String(row.id),
      authority: 'agent_assertion',
      text: String(row.candidate_summary),
    }));
  if (Array.isArray(value.decisions))
    for (const decision of value.decisions.slice(0, 128)) {
      if (
        record(decision) &&
        typeof decision.id === 'string' &&
        typeof decision.rationale === 'string' &&
        decision.rationale.trim()
      )
        trail.reasons.push({
          id: decision.id,
          authority: 'owner_decision',
          text: decision.rationale,
        });
    }
  if (Array.isArray(value.revisions))
    for (const item of value.revisions.slice(0, 128)) {
      if (!record(item) || typeof item.candidate_id !== 'string') continue;
      const ref = revision(item.revision);
      if (!ref) continue;
      trail.revisions.push({
        label: typeof item.label === 'string' ? item.label : 'Recorded capture',
        selection: {
          repo_id: source.repo_id,
          kind: 'captured',
          candidate_id: item.candidate_id,
          revision: ref,
        },
      });
    }
  // Native why currently supplies no frozen context records. Capture IDs/epochs are not context IDs/versions.
  const evaluation = value.evaluation,
    ref = record(evaluation) ? revision(evaluation.revision) : undefined;
  if (
    record(evaluation) &&
    ref &&
    evaluation.authority === 'historical_checked_revision' &&
    ref.repository === source.revision.repository &&
    ref.commit === source.revision.commit &&
    typeof evaluation.id === 'string' &&
    typeof evaluation.policy === 'string' &&
    typeof evaluation.suite === 'string' &&
    typeof evaluation.environment === 'string' &&
    typeof evaluation.evidence === 'string' &&
    /^[a-f0-9]{64}$/.test(evaluation.evidence) &&
    (source.kind !== 'checked' ||
      (evaluation.id === source.evaluation_id && evaluation.policy === source.policy_version))
  ) {
    trail.evaluation = {
      id: evaluation.id,
      policy_version: evaluation.policy,
      suite: evaluation.suite,
      environment: evaluation.environment,
      evidence_digest: evaluation.evidence,
    };
    if (Array.isArray(value.checks))
      for (const item of value.checks.slice(0, 128)) {
        if (
          record(item) &&
          typeof item.name === 'string' &&
          (item.status === 'pass' || item.status === 'fail' || item.status === 'pending')
        )
          trail.checks.push({ name: item.name, status: item.status });
      }
  }
  return trail;
}
