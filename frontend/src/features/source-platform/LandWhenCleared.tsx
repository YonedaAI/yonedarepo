// Land when cleared on a Landing's page, from what the server computed: while it is open, that
// the platform will land it and what it waits for; once it has, that it did, and why.
import type { Clearance } from '../../../../shared/contracts/change-gates';
import { type ChangeDetail, landedAutomatically } from './changeModel';
import { usePeople } from './people';
import { when } from './sourceApi';

/** The clearance panel's note, with the repository's switch on. */
export function WillLandNote({ clearance }: { clearance: Clearance }) {
  const { waiting, refused } = clearance;
  return (
    <div className="source-will-land">
      <p>
        <strong>Will land when cleared.</strong>{' '}
        {waiting.length
          ? 'Waiting for:'
          : refused
            ? 'It tries again on its next check, review or push.'
            : 'Nothing is in the way: it lands on its next check, review or push.'}
      </p>
      {waiting.length > 0 && (
        <ul>
          {waiting.map((hold) => (
            <li key={`${hold.code}:${hold.reason}`} data-state="waiting">
              {hold.reason}
            </li>
          ))}
        </ul>
      )}
      {refused && (
        <p role="status">
          <strong>The last attempt did not land.</strong> {refused.reason} · {when(refused.at)}
        </p>
      )}
    </div>
  );
}

/** What the platform landed and the gates that decided it, on a landed Landing's page. */
export function LandedAutomatically({ change }: { change: ChangeDetail }) {
  const people = usePeople();
  const landed = landedAutomatically(change);
  if (!landed) return null;
  return (
    <div className="source-will-land">
      <p>
        <strong>Landed automatically</strong> by the platform once it cleared · {when(landed.at)}
      </p>
      <ul aria-label="Why it landed">
        {landed.approved_by.map((principal) => (
          <li key={principal} data-state="ready">
            Approved by {people.principal(principal)}
          </li>
        ))}
        {landed.gates.map((gate) => (
          <li key={gate.name} data-state="ready">
            <strong>{gate.name}</strong> {gate.why}
          </li>
        ))}
      </ul>
    </div>
  );
}
