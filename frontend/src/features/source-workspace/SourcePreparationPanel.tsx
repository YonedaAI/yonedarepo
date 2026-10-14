import type { SourcePreparation, SourceWorkflowStage } from '../../lib/sourceWorkspace';
import { preparationView } from './sourcePreparation';
import './source-workspace.css';

export function SourcePreparationPanel({
  transport,
  preparation,
  stage,
  refreshing = false,
  onRefresh,
}: {
  transport?: string;
  preparation?: SourcePreparation;
  stage: SourceWorkflowStage;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const view = preparationView(transport, preparation, stage);
  if (!view) return null;
  return (
    <section className="source-preparation" aria-label="Run progress">
      <h3 role={view.error ? 'alert' : 'status'}>{view.title}</h3>
      <p>{view.detail}</p>
      <ol aria-label="From approved source to review">
        <li aria-current={view.stage === 'preparing' ? 'step' : undefined}>Preparing source</li>
        <li
          aria-current={view.stage === 'working' || view.stage === 'waiting' ? 'step' : undefined}
        >
          Agent working
        </li>
        <li aria-current={view.stage === 'checking' ? 'step' : undefined}>Independent checks</li>
        <li aria-current={view.stage === 'review' ? 'step' : undefined}>Human review</li>
      </ol>
      {view.error && onRefresh && (
        <button type="button" className="quiet" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? 'Refreshing status…' : 'Refresh source status'}
        </button>
      )}
    </section>
  );
}
