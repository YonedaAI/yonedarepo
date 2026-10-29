// The change's gates, at the top of its page: what its head still needs before it can land,
// one requirement per line (ready, waiting or blocked, and why), from one read
// (`GET /changes/:n/gates`). The server decides; enforced requirements come first, and the
// ones landing does not wait for are marked.
import type { ChangeGates, GateRequirement } from '../../../../shared/contracts/change-gates';
import { Failure, Loading } from './SourceStatus';
import type { Loaded } from './useSource';

const STATE_LABEL = { ready: 'Ready', waiting: 'Waiting', blocked: 'Blocked' } as const;

/** The panel's heading: ready, or what is in the way (enforced requirements only). */
export function gatesHeading(gates: ChangeGates) {
  if (gates.ready) return 'Ready to land';
  const open = gates.requirements.filter((r) => r.enforced && r.state !== 'ready');
  const count = (state: GateRequirement['state']) => open.filter((r) => r.state === state).length;
  const parts = [
    count('blocked') && `${count('blocked')} blocked`,
    count('waiting') && `${count('waiting')} waiting`,
  ].filter(Boolean);
  return parts.length ? `Not ready to land: ${parts.join(', ')}` : 'Not ready to land';
}

export function MergeGates({ gates }: { gates: Loaded<ChangeGates> }) {
  if (gates.error) return <Failure error={gates.error} onRetry={gates.reload} />;
  const data = gates.data;
  if (!data) return <Loading what="gates" />;
  // Stable: enforced requirements first, each group in the server's order.
  const shown = [
    ...data.requirements.filter((r) => r.enforced),
    ...data.requirements.filter((r) => !r.enforced),
  ];
  return (
    <section className="source-gates source-merge-gates" aria-labelledby="gates-heading">
      <h3 id="gates-heading">Gates</h3>
      <p className="source-merge-gates-summary">{gatesHeading(data)}</p>
      <ul>
        {shown.map((r) => (
          <li key={`${r.kind}:${r.name}`} data-state={r.state}>
            <span className="source-gate-state">{STATE_LABEL[r.state]}</span>{' '}
            <strong>{r.name}</strong> {r.why}
            {!r.enforced && <span className="source-meta"> (not enforced)</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
