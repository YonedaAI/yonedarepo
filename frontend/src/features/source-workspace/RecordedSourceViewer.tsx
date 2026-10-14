import { useState } from 'react';
import type { SourceSelection } from '../../lib/sourceWorkspace';
import { ReadOnlySourceViewer } from './ReadOnlySourceViewer';
import { createSourceApiReader } from './sourceApiReader';
import { sourceIdentity } from './sourceReader';

const reader = createSourceApiReader();
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export function recordedCandidateSelection(
  repo: string,
  candidate: unknown,
  evaluation?: unknown,
): SourceSelection | undefined {
  if (
    !record(candidate) ||
    typeof candidate.id !== 'string' ||
    !candidate.id ||
    !record(candidate.revision) ||
    typeof candidate.revision.repository !== 'string' ||
    !candidate.revision.repository ||
    !hex(candidate.revision.commit)
  )
    return;
  const selection: SourceSelection = {
    repo_id: repo,
    kind: 'captured',
    candidate_id: candidate.id,
    revision: {
      repository: candidate.revision.repository,
      commit: candidate.revision.commit,
      ...(hex(candidate.tree)
        ? { tree: candidate.tree }
        : hex(candidate.revision.tree)
          ? { tree: candidate.revision.tree }
          : {}),
    },
  };
  if (
    record(evaluation) &&
    evaluation.id === candidate.evaluation &&
    evaluation.candidate === candidate.id &&
    record(evaluation.revision) &&
    evaluation.revision.repository === candidate.revision.repository &&
    evaluation.revision.commit === candidate.revision.commit &&
    typeof evaluation.id === 'string' &&
    typeof evaluation.policy === 'string' &&
    typeof evaluation.suite === 'string' &&
    typeof evaluation.environment === 'string' &&
    typeof evaluation.evidence === 'string' &&
    /^[a-f0-9]{64}$/.test(evaluation.evidence) &&
    Array.isArray(evaluation.checks) &&
    evaluation.checks.length > 0 &&
    evaluation.checks.every((check) => record(check) && check.status === 'pass')
  ) {
    return {
      ...selection,
      kind: 'checked',
      evaluation_id: evaluation.id,
      policy_version: evaluation.policy,
    };
  }
  return selection;
}
/** Captured identity is recorded; eligibility and publication remain with their existing authoritative UI. */
export function RecordedSourceViewer({
  repo,
  candidate,
  evaluation,
}: {
  repo: string;
  candidate: unknown;
  evaluation?: unknown;
}) {
  const selection = recordedCandidateSelection(repo, candidate, evaluation);
  if (!selection)
    return (
      <p role="alert">
        The captured source identity is incomplete. Refresh the result before opening its files.
      </p>
    );
  return <RecordedSourceSession key={sourceIdentity(selection)} initial={selection} />;
}
function RecordedSourceSession({ initial }: { initial: SourceSelection }) {
  const [selection, setSelection] = useState(initial);
  return (
    <>
      {sourceIdentity(selection) !== sourceIdentity(initial) && (
        <button type="button" className="text-button" onClick={() => setSelection(initial)}>
          Return to this result’s source
        </button>
      )}
      <ReadOnlySourceViewer
        selection={selection}
        reader={reader}
        onInspectRevision={setSelection}
      />
    </>
  );
}
