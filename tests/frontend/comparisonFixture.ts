import type { ComparisonState } from '../../frontend/src/lib/comparison';
import type { Snapshot } from '../../frontend/src/lib/types';

/** Synthetic UI receipts only; no agent work, provider calls or acceptance evidence. */
export function comparisonFixture() {
  const run = { id: 'compare', mode: 'compare', status: 'ready', intent: 'Fix event filtering and preserve anonymous access.',
    criteria: ['Preserve event names'], context: [], context_records: [], working_branch_id: 'work', working_branch_version: 2,
    base: { repository: 'source', commit: 'base' } };
  const candidates = ['left', 'right'].map(id => ({ id, run_id: run.id, execution: id, status: 'eligible', summary: `${id} filtering implementation`,
    base: run.base, revision: { repository: 'source', commit: id }, evaluation: `check-${id}`, paths: ['app.ts'] }));
  const snapshot = { repository: { id: 'repo', name: 'Synthetic compare fixture', status: 'ready', pending: null,
    head_commit: 'canonical', published_commit: 'canonical', version: 4,
    policy: { version: 'policy', suite: 'commands-v1', environment: 'test', required_checks: ['behavior'] } },
    runs: [run], candidates, executions: candidates.map((c, agent_index) => ({ id: c.execution, agent_index, run_id: run.id,
      role: 'coding', status: 'completed', provider: 'zai', model: 'glm-5.3-flash', strategy: `Builder ${agent_index + 1}` })),
    evaluations: candidates.map(c => ({ id: c.evaluation, candidate: c.id, revision: c.revision, policy: 'policy',
      suite: 'commands-v1', environment: 'test', evidence: 'a'.repeat(64), checks: [{ name: 'behavior', status: 'pass', detail: 'Synthetic behavior receipt' }],
      app: { bundle_digest: `synthetic-${c.id}`, revision: c.revision.commit, policy_digest: 'synthetic' } })),
    working_branches: [{ id: 'work', status: 'active', version: 2, working_commit: 'base', working_revision: run.base,
      canonical_base_commit: 'canonical', canonical_base_version: 4, latest_candidate_id: null }],
    decisions: [], artifacts: [], nodes: [], edges: [], seq: 1 } as unknown as Snapshot;
  const comparison: ComparisonState = { version: 1, status: 'selected', round: 0, selected_candidate_id: 'left', selection_version: 1,
    selected_by: 'comparison_reviewer', latest_review_id: 'proposal', manifest_digest: 'b'.repeat(64),
    approval: { id: 'approval', digest: 'c'.repeat(64) }, latest_review: { id: 'proposal', outcome: 'selected', selected_candidate_id: 'left',
      rationale: 'The first approach preserves the existing access contract.', alternatives: [
        { candidate_id: 'left', reason: 'Handles the required edge cases.' }, { candidate_id: 'right', reason: 'More complex filtering needs additional review.' }],
      risks: ['Large event catalogs still need load testing.'], manifest_digest: 'b'.repeat(64), evidence_refs: ['check-left', 'check-right'] } };
  return { snapshot, run, candidates, comparison };
}
