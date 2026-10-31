// Legal holds as people see them: a banner on a held repository or organization, delete
// controls turned off, and the owners' control on the organization's page. A hold has two
// layers (owners', operators'), and either keeps it standing; each side releases its own.
// The server decides all of it: where the feature is off these reads answer 404 and nothing
// shows, and a control that shows anyway is refused with 423.
import { Scale } from 'lucide-react';
import { Failure } from './SourceStatus';
import { sourceApi, when } from './sourceApi';
import { useChange } from './useChange';
import { useSource } from './useSource';

type HoldLayer = { at: number; by: string };
export type Hold = { owner?: HoldLayer; operator?: HoldLayer };
export type OrgHolds = { org: Hold | null; repos: Record<string, Hold> };

/** Why a delete control is off. */
export const HELD_NOTE = 'Under a legal hold: this cannot be deleted until the hold is released.';

/** Whether `repo` is held (null: don't ask). Unknown reads as not held: the server refuses. */
export function useRepoHold(repo: string | null) {
  const path = repo === null ? null : `/repos/${repo}/hold`;
  return useSource<{ held: boolean }>(path).data?.held === true;
}

/** Who set `hold`, in a line; an operator's stands however the owners' goes. */
export function heldBy(hold: Hold) {
  const set = [hold.owner, hold.operator].filter((l) => l !== undefined);
  const since = when(Math.min(...set.map((l) => l.at)));
  if (hold.operator && hold.owner) return `Set by an owner and an operator, since ${since}.`;
  if (hold.operator) return `Set by an operator, since ${since}. Only an operator can release it.`;
  return `Set by ${hold.owner?.by.replace(/^user:/, '')}, since ${since}.`;
}

/** Anything of this org on hold: it cannot be deleted then. */
export const orgHeld = (holds?: OrgHolds) =>
  !!holds && (!!holds.org || Object.keys(holds.repos).length > 0);

function Banner({ text, detail }: { text: string; detail?: string }) {
  return (
    <p className="source-change-banner" role="status">
      <Scale size={14} aria-hidden="true" /> {text} {detail}
    </p>
  );
}

/** The banner under a held repository's status chips. */
export function RepoHoldBanner({ repo }: { repo: string }) {
  if (!useRepoHold(repo)) return null;
  return <Banner text="Legal hold: nothing in this repository can be deleted until released." />;
}

/** An owner's place or release of one hold, confirmed first. */
function HoldButton({
  path,
  name,
  hold,
  onChanged,
}: {
  path: string;
  name: string;
  hold?: Hold | null;
  onChanged: () => void;
}) {
  const { busy, error, run } = useChange(onChanged);
  const placing = !hold?.owner;
  // An operator's alone: the owners have nothing of their own to release.
  if (hold?.operator && !hold.owner) return null;
  function toggle() {
    const what = placing
      ? `Place a legal hold on ${name}? Nothing in it can be deleted until it is released.`
      : `Release the legal hold on ${name}? Deleting it becomes possible again.`;
    if (!window.confirm(what)) return;
    void run(() =>
      placing ? sourceApi(path, { body: {} }) : sourceApi(path, { method: 'DELETE' }),
    );
  }
  return (
    <>
      <button
        type="button"
        className="quiet"
        disabled={busy}
        aria-label={`${placing ? 'Place' : 'Release'} legal hold on ${name}`}
        onClick={toggle}
      >
        {placing ? 'Place legal hold' : 'Release legal hold'}
      </button>
      {error && <Failure error={error} />}
    </>
  );
}

/** The hold on the organization as a whole: what stands, and the owners' control. */
export function OrgHoldSection({
  org,
  holds,
  manages,
  onChanged,
}: {
  org: string;
  holds: OrgHolds;
  manages: boolean;
  onChanged: () => void;
}) {
  const hold = holds.org;
  return (
    <section aria-labelledby="org-hold-heading">
      <h2 id="org-hold-heading">Legal hold</h2>
      {hold ? (
        <Banner
          text="Legal hold: nothing this organization owns can be deleted until released."
          detail={heldBy(hold)}
        />
      ) : (
        <p className="source-meta">
          A hold keeps everything the organization owns from being deleted, including repositories
          made later. Landing and reads carry on.
        </p>
      )}
      {manages && (
        <HoldButton
          path={`/orgs/${encodeURIComponent(org)}/hold`}
          name={org}
          hold={hold}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

/** One repository's hold, in the organization's list. */
export function OrgRepoHold({
  org,
  repo,
  name,
  hold,
  manages,
  onChanged,
}: {
  org: string;
  repo: string;
  name: string;
  hold?: Hold;
  manages: boolean;
  onChanged: () => void;
}) {
  return (
    <>
      {hold && (
        <span className="chip" title={heldBy(hold)}>
          <Scale size={14} aria-hidden="true" /> On hold
        </span>
      )}
      {manages && (
        <HoldButton
          path={`/orgs/${encodeURIComponent(org)}/repos/${repo}/hold`}
          name={name}
          hold={hold}
          onChanged={onChanged}
        />
      )}
    </>
  );
}
