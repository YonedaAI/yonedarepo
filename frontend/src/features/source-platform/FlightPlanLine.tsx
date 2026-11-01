// A change's flight plan on its header: the goal filed before the work, and its scope. Filing
// one is encouraged, never required, so a change without one says so plainly.
import type { FlightPlan } from './changeModel';

export function FlightPlanLine({ plan }: { plan?: FlightPlan | null }) {
  if (!plan) return <p className="source-meta">No flight plan</p>;
  return (
    <dl className="source-flight-plan">
      <dt>Flight plan</dt>
      <dd>{plan.goal}</dd>
      {plan.scope && (
        <>
          <dt>Scope</dt>
          <dd>{plan.scope}</dd>
        </>
      )}
    </dl>
  );
}
