import type { Snapshot } from '../../lib/types';
import { recordedRationale } from './agentsPick';

/** Agent rationale exactly as recorded in handoffs; absent records are stated, never filled in. */
export function AgentsRationale({
  snapshot,
  run,
  candidate,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  candidate: Record<string, any>;
}) {
  const rationale = recordedRationale(snapshot, run, candidate);
  return (
    <section className="agents-rationale">
      <h3>Why the agents picked this</h3>
      {rationale.length ? (
        <ul>
          {rationale.map((item) => (
            <li key={item.id}>
              <p>{item.text}</p>
              <small>{item.source} · agent assertion</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="subtle">No agent rationale was recorded for this result.</p>
      )}
    </section>
  );
}
