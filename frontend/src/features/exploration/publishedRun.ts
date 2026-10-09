import type { Snapshot } from '../../lib/types';
import type { AgentDraft } from './agentLimits';

type RecordData = Record<string, any>;
export interface PublishedRun {
  decision: RecordData;
  run: RecordData;
  candidate: RecordData;
  execution?: RecordData;
}

export const preservePublishedApproach =
  'Preserve the published design and behavior; implement only the requested changes';
export const preservePublishedCriteria =
  'Preserve the published design and working behavior except where this change requires an update';

/** Resolve the exact canonical publication, never the most recent draft or failed run. */
export function publishedRun(snapshot: Snapshot): PublishedRun | undefined {
  const commit = snapshot.repository.published_commit;
  for (const decision of [...snapshot.decisions].reverse()) {
    if (decision.status !== 'published' || decision.target?.commit !== commit) continue;
    const candidate = snapshot.candidates.find(
      (item) => item.id === decision.candidate && item.revision?.commit === commit,
    );
    const run = snapshot.runs.find((item) => item.id === decision.run_id);
    if (!candidate || !run || candidate.run_id !== run.id) continue;
    const execution = snapshot.executions.find(
      (item) => item.id === candidate.execution && item.run_id === run.id,
    );
    return { decision, candidate, run, execution };
  }
}

export function publishedAgent(publication: PublishedRun): AgentDraft | undefined {
  const execution = publication.execution;
  if (!execution?.strategy) return;
  return {
    id: crypto.randomUUID(),
    connection: execution.connection ?? '',
    strategy: execution.strategy,
    expectedProvider: execution.provider,
    expectedModel: execution.model,
    fromPreviousRun: true,
  };
}

/** Carry selected provenance and assertions; competing agents' new assertions stay opt-in. */
export function publishedContext(snapshot: Snapshot, publication: PublishedRun) {
  const lineage = new Set<string>();
  let execution = publication.execution;
  while (execution && !lineage.has(execution.id)) {
    lineage.add(execution.id);
    execution = snapshot.executions.find(
      (item) => item.id === execution?.parent_execution && item.run_id === publication.run.id,
    );
  }
  for (const item of snapshot.executions) {
    if (item.run_id === publication.run.id && item.role === 'research') lineage.add(item.id);
  }
  const artifacts = snapshot.artifacts.filter((item) => lineage.has(item.producer));
  const artifactIds = new Set(artifacts.map((item) => item.id));
  const nodes = new Set(snapshot.nodes.map((item) => item.id));
  const requested = [
    publication.decision.id,
    `intent:${publication.run.id}`,
    publication.candidate.id,
    publication.candidate.evaluation,
    publication.execution?.id,
    ...artifactIds,
    ...(publication.run.context ?? []),
    ...(publication.execution?.context ?? []),
    ...snapshot.nodes.filter((item) => lineage.has(item.author)).map((item) => item.id),
    ...snapshot.edges
      .filter((edge) => artifactIds.has(edge.source) && edge.relation === 'states')
      .map((edge) => edge.target),
  ];
  const ids = [...new Set(requested.filter((id): id is string => !!id && nodes.has(id)))];
  return { ids: ids.slice(0, 50), total: ids.length };
}
