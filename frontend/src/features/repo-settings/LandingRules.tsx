// Landing rules: approvals, required checks and the review classes that land without a
// human approval.
import { useState } from 'react';
import { AUTO_APPROVABLE, listFromText, type Policy, withRequiredChecks } from './policy';

export function LandingRules({ draft, change }: { draft: Policy; change: (next: Policy) => void }) {
  // The list is typed as text; it becomes the policy's list as the owner types.
  const [checks, setChecks] = useState(draft.required_checks.join('\n'));
  // A draft changed elsewhere (discarded, or set by Checks) resets the typed text.
  if (listFromText(checks).join('\n') !== draft.required_checks.join('\n'))
    setChecks(draft.required_checks.join('\n'));
  const auto = draft.auto_approve ?? [];
  return (
    <>
      <label className="source-field">
        Approvals needed to land on main
        <input
          type="number"
          min={0}
          max={10}
          value={draft.approvals}
          onChange={(e) => change({ ...draft, approvals: Math.max(0, Number(e.target.value)) })}
          required
        />
        <small className="subtle">
          Independent approvals from accounts other than the author. 0 lands without review.
        </small>
      </label>
      <label className="source-field settings-wide">
        Required checks
        <textarea
          value={checks}
          rows={3}
          spellCheck={false}
          onChange={(e) => {
            setChecks(e.target.value);
            change(withRequiredChecks(draft, listFromText(e.target.value)));
          }}
          aria-describedby="required-checks-help"
        />
        <small id="required-checks-help" className="subtle">
          One check name per line (lowercase letters, digits, . _ -). A commit lands only when each
          has passed on that exact commit. Checks the platform runs itself are set up under Checks.
        </small>
      </label>
      <fieldset className="source-checks" disabled={draft.approvals === 0}>
        <legend>Land without an approval when a change is only</legend>
        {AUTO_APPROVABLE.map((c) => (
          <label key={c.id}>
            <input
              type="checkbox"
              checked={auto.includes(c.id)}
              onChange={(e) => {
                const next = e.target.checked ? [...auto, c.id] : auto.filter((a) => a !== c.id);
                const { auto_approve: _, ...rest } = draft;
                change(next.length ? { ...rest, auto_approve: next } : rest);
              }}
            />
            {c.label}
          </label>
        ))}
      </fieldset>
    </>
  );
}
