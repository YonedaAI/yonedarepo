import { short } from '../../lib/api';
import type { TeamRecord } from './teamView';
export function TeamHandoff({ handoff }: { handoff: TeamRecord }) {
  if (handoff.authority === 'captured_revision')
    return (
      <div className="team-handoff">
        <strong>Trusted source capture</strong>
        <p>
          Revision <code>{short(handoff.output?.revision?.commit)}</code> · tree{' '}
          <code>{short(handoff.output?.tree)}</code>
        </p>
        <p>
          Captured source is an input to integration; final behavior is checked on the integrated
          revision.
        </p>
      </div>
    );
  if (handoff.authority === 'superseded')
    return (
      <div className="team-handoff">
        <strong>Superseded source capture</strong>
        <p>
          Earlier revision <code>{short(handoff.output?.revision?.commit)}</code> · tree{' '}
          <code>{short(handoff.output?.tree)}</code>
        </p>
        <p>This capture remains in history; a later source capture superseded it.</p>
      </div>
    );
  if (handoff.authority !== 'assertion') return null;
  return (
    <div className="team-handoff">
      <strong>Agent handoff · assertion</strong>
      <p>{handoff.summary || 'No summary recorded.'}</p>
      {handoff.interface_contract && <p>Interface: {handoff.interface_contract}</p>}
      {handoff.references?.length > 0 && (
        <p>
          Cited context:{' '}
          {handoff.references.map((id: string) => (
            <code key={id}>{id} </code>
          ))}
        </p>
      )}
    </div>
  );
}
