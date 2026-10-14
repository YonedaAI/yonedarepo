import type { Snapshot } from '../../lib/types';
import { runSourceProgress } from './sourceRunProgress';
import './source-workspace.css';

export function RunSourceProgress({
  snapshot,
  run,
  busy,
  onRefresh,
}: {
  snapshot: Snapshot;
  run: Record<string, unknown>;
  busy?: boolean;
  onRefresh?: () => Promise<void>;
}) {
  if (snapshot.capabilities?.source_api !== 1) return null;
  const progress = runSourceProgress(snapshot, run);
  if (!progress) return null;
  return (
    <section className="source-preparation" aria-label="Source and review progress">
      <h3 role={progress.error ? 'alert' : 'status'}>{progress.title}</h3>
      <p>{progress.detail}</p>
      <ol aria-label="From approved source to review">
        {[
          ['preparing', 'Preparing source'],
          ['working', 'Agent working'],
          ['checking', 'Independent checks'],
          ['review', 'Human review'],
        ].map(([stage, title]) => (
          <li
            key={stage}
            aria-current={
              progress.stage === stage ||
              (stage === 'working' && progress.stage === 'waiting') ||
              (stage === 'review' && progress.stage === 'choice')
                ? 'step'
                : undefined
            }
          >
            {title}
          </li>
        ))}
      </ol>
      {onRefresh &&
        (progress.stage === 'preparing' || progress.stage === 'waiting' || progress.error) && (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => void onRefresh().catch(() => {})}
          >
            Refresh run status
          </button>
        )}
    </section>
  );
}
