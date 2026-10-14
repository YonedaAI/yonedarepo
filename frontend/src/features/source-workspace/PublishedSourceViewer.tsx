import type { SourceSelection } from '../../lib/sourceWorkspace';
import type { Snapshot } from '../../lib/types';
import { ReadOnlySourceViewer } from './ReadOnlySourceViewer';
import { createSourceApiReader } from './sourceApiReader';

const reader = createSourceApiReader();
/** The publication selector reads current canonical source; it cannot be used as an arbitrary old Git ref. */
export function publishedSourceSelection(
  snapshot: Snapshot,
  runId: string,
): SourceSelection | undefined {
  if (snapshot.capabilities?.source_api !== 1) return;
  const decision = snapshot.decisions.find(
    (item) => item.run_id === runId && item.status === 'published',
  );
  const commit = snapshot.repository.published_commit;
  if (
    !decision ||
    decision.target?.commit !== commit ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)
  )
    return;
  return {
    repo_id: snapshot.repository.id,
    kind: 'published',
    decision_id: decision.id,
    revision: {
      repository: `${snapshot.repository.remote.namespace}/${snapshot.repository.remote.name}`,
      commit,
    },
  };
}
export function PublishedSourceViewer({ snapshot, runId }: { snapshot: Snapshot; runId: string }) {
  const selection = publishedSourceSelection(snapshot, runId);
  return selection ? <ReadOnlySourceViewer selection={selection} reader={reader} /> : null;
}
