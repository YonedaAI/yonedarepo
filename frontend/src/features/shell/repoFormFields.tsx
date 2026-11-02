// The owner and visibility fields of the dialogs that make a repository.
import { VISIBILITIES, VISIBILITY_HELP, VISIBILITY_LABELS } from '../repo-settings/visibilityModel';
import { type OrgSummary, ownerOptions } from '../source-platform/orgModel';

/** The owner picker: nothing for an account that owns no organization. */
export function OwnerField({
  account,
  orgs,
  initialOwner,
  disabled,
  onOwner,
}: {
  account?: string;
  orgs: OrgSummary[];
  /** Preselected owner (the open org page), when the caller owns it. */
  initialOwner?: string;
  disabled: boolean;
  onOwner?: (owner: string) => void;
}) {
  const owners = ownerOptions(account, orgs);
  if (owners.length <= 1) return null;
  const preselected = owners.some((o) => o.value && o.value === initialOwner) ? initialOwner : '';
  return (
    <label>
      Owner
      <select
        name="owner"
        defaultValue={preselected}
        disabled={disabled}
        onChange={(event) => onOwner?.(event.target.value)}
      >
        {owners.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Private (the default) or public, or only private when the source is. */
export function VisibilityField({
  disabled,
  onlyPrivate = false,
}: {
  disabled: boolean;
  onlyPrivate?: boolean;
}) {
  if (onlyPrivate)
    return (
      <p className="source-meta">
        <input type="hidden" name="visibility" value="private" />
        Private, like its source on GitHub.
      </p>
    );
  return (
    <fieldset className="visibility-choice" disabled={disabled}>
      <legend>Visibility</legend>
      {/* Each radio is named by its label alone ("Private", "Public"); the help text is
          its description, outside the label, so no other control's name says "Owner". */}
      {VISIBILITIES.map((v) => (
        <div key={v} className="visibility-option">
          <label>
            <input
              type="radio"
              name="visibility"
              value={v}
              defaultChecked={v === 'private'}
              aria-describedby={`visibility-${v}-help`}
            />
            <strong>{VISIBILITY_LABELS[v]}</strong>
          </label>
          <small id={`visibility-${v}-help`}>{VISIBILITY_HELP[v]}</small>
        </div>
      ))}
    </fieldset>
  );
}
