import type { ContextUsage } from '../../../../shared/context_usage';
import type { GraphNode, Snapshot } from '../../lib/types';

export const contextText = (value: unknown) => (typeof value === 'string' ? value : '');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function contextRecord(value: unknown): GraphNode | null {
  if (!object(value) || !contextText(value.id) || !contextText(value.kind)) return null;
  return {
    id: contextText(value.id),
    kind: contextText(value.kind),
    label: contextText(value.label),
    author: contextText(value.author),
    recorded_at: typeof value.recorded_at === 'number' ? value.recorded_at : 0,
    data: object(value.data) ? value.data : {},
  };
}
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item)
    : [];

export function contextAuthority(kind: string) {
  if (['candidate', 'team_handoff'].includes(kind)) return 'Captured revision';
  if (kind === 'evaluation') return 'Checked revision';
  if (kind === 'decision') return 'Recorded decision';
  if (kind === 'source') return 'Source revision';
  if (['execution', 'run', 'repository', 'team_task', 'integration_manifest'].includes(kind))
    return 'Platform record';
  return 'Assertion';
}

export function contextBody(record: GraphNode) {
  return contextText(record.data.statement) || contextText(record.data.rationale) || record.label;
}
export function contextRelations(record: GraphNode) {
  const links = Array.isArray(record.data.links) ? record.data.links : [];
  const result = links
    .filter(object)
    .filter((link) => contextText(link.relation) && contextText(link.target))
    .map((link) => ({
      relation: contextText(link.relation).replaceAll('_', ' '),
      target: contextText(link.target),
    }));
  if (contextText(record.data.intent_id))
    result.push({ relation: 'addresses', target: record.data.intent_id });
  return result;
}
export function contextPaths(record: GraphNode) {
  return [...new Set([...strings(record.data.file_paths), ...strings([record.data.path])])];
}

/** Mirror native initial_context: study corpus availability is distinct from assigned input. */
export function frozenInputs(run: Record<string, unknown>) {
  const study = object(run.context_study) ? run.context_study : null;
  const source = study ? (study.arm === 'plain_notes' ? study.records : []) : run.context_records;
  const records = Array.isArray(source)
    ? source.map(contextRecord).filter((record) => record !== null)
    : [];
  const byId = new Map(records.map((record) => [record.id, record]));
  const ids = [...new Set([...(!study ? strings(run.context) : []), ...byId.keys()])];
  return { records: byId, ids };
}

export function contextActivity(
  id: string,
  snapshot: Snapshot,
  runId: string,
  evidence: ContextUsage | null,
) {
  const usage = evidence?.run_id === runId ? evidence : null;
  const assigned = new Set<string>();
  for (const execution of snapshot.executions)
    if (execution.run_id === runId && strings(execution.context).includes(id))
      assigned.add(execution.id);
  for (const row of usage?.assigned ?? [])
    if (row.targets.some((target) => target.id === id)) assigned.add(row.execution_id);
  const opened = new Set(
    (usage?.entries ?? [])
      .filter(
        (entry) => entry.stage === 'opened' && entry.targets.some((target) => target.id === id),
      )
      .map((entry) => entry.execution_id ?? 'Remote session'),
  );
  const cited = new Set(
    (usage?.citations ?? [])
      .filter((citation) => citation.targets.some((target) => target.id === id))
      .map((citation) => citation.execution_id ?? 'Unattributed session'),
  );
  return {
    assigned: [...assigned],
    opened: [...opened],
    cited: [...cited],
    loaded: usage !== null,
  };
}
