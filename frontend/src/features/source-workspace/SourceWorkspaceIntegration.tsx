import type {
  SourceContextLink,
  SourcePreparation,
  SourceReader,
  SourceSelection,
  SourceWorkflowStage,
} from '../../lib/sourceWorkspace';
import { ReadOnlySourceViewer } from './ReadOnlySourceViewer';
import { SourcePreparationPanel } from './SourcePreparationPanel';

/** Parent wires verified owner DTOs here; this component performs no transport selection or writes. */
export function SourceWorkspaceIntegration({
  sourceApi,
  transport,
  preparation,
  stage,
  selection,
  reader,
  refreshing,
  onRefreshSource,
  onInspectContext,
  onInspectRevision,
}: {
  sourceApi?: number;
  transport?: string;
  preparation?: SourcePreparation;
  stage: SourceWorkflowStage;
  selection?: SourceSelection;
  reader?: SourceReader;
  refreshing?: boolean;
  onRefreshSource?: () => void;
  onInspectContext?: (link: SourceContextLink) => void;
  onInspectRevision?: (source: SourceSelection) => void;
}) {
  if (sourceApi !== 1) return null;
  return (
    <>
      <SourcePreparationPanel
        transport={transport}
        preparation={preparation}
        stage={stage}
        refreshing={refreshing}
        onRefresh={onRefreshSource}
      />
      {selection && reader && (
        <ReadOnlySourceViewer
          selection={selection}
          reader={reader}
          onRefreshSource={onRefreshSource}
          onInspectContext={onInspectContext}
          onInspectRevision={onInspectRevision}
        />
      )}
    </>
  );
}
