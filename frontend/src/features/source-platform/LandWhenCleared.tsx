// CTC, Code Traffic Control, on a Landing's page, from what the server decided: while it is
// open, what CTC is waiting for or why the work goes back; once CTC landed it, why.
import type { LandingClearance } from '../../../../shared/contracts/change-gates';
import { type ChangeDetail, landedAutomatically } from './changeModel';
import { usePeople } from './people';
import { when } from './sourceApi';

/** One line under the decision, when it has no reasons to list. */
const clearLine = (refused: boolean) =>
  refused
    ? 'It tries again on its next check, review or push.'
    : 'Nothing is in the way: it lands on its next check, review or push.';

/** The clearance panel's note, with the repository's switch on. */
export function WillLandNote({ clearance }: { clearance: LandingClearance }) {
  const { decision, reasons, refused } = clearance;
  return (
    <div className="source-will-land">
      <p>
        {decision === 'go_around' ? (
          <>
            <strong>Tower: go-around.</strong> The work goes back:
          </>
        ) : (
          <>
            <strong>Tower: will land when cleared.</strong>{' '}
            {reasons.length ? 'Waiting for:' : clearLine(refused !== null)}
          </>
        )}
      </p>
      {reasons.length > 0 && (
        <ul>
          {reasons.map((hold) => (
            <li key={`${hold.code}:${hold.reason}`}>{hold.reason}</li>
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

/** What CTC landed and what decided it, on a landed Landing's page. */
export function LandedAutomatically({ change }: { change: ChangeDetail }) {
  const people = usePeople();
  const landed = landedAutomatically(change);
  if (!landed) return null;
  return (
    <div className="source-will-land">
      <p>
        <strong>Landed automatically</strong> by Tower once it cleared · {when(landed.at)}
      </p>
      <ul aria-label="Why it landed">
        {landed.state?.approved_by.map((principal) => (
          <li key={principal}>Approved by {people.principal(principal)}</li>
        ))}
        {landed.state?.requirements.map((gate) => (
          <li key={gate.name}>
            <strong>{gate.name}</strong> {gate.why}
          </li>
        ))}
      </ul>
    </div>
  );
}
