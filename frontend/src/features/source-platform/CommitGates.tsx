// Landing gates, review buttons and land conflicts, shared by commit and change pages.
import { useState } from 'react';
import type { BreakGlassRecord } from './BreakGlass';
import type { Repair } from './CommitRepairs';
import { classLabel, gateNeeds } from './commitPanel';

export type Gates = {
  ready: boolean;
  auto_approved?: boolean;
  approvals: number;
  approvals_required: number;
  rejected: boolean;
  missing_checks: string[];
  failing_checks: string[];
};

export type ReviewClasses = { overall: string; files: { path: string; class: string }[] } | null;
export type Landing = { refname: string; version: number; landed_at: number };
export type Conflict = { path: string; kind: string; marked?: string };

/** git_show's answer for one commit. */
export type CommitDetail = {
  commit: string;
  message: string;
  principal: string;
  parents: string[];
  read_set: string[];
  checks: { name: string; status: string; principal: string; recorded_at: number }[];
  check_runs: { id: string; name: string; status: string; epoch: number }[];
  reviews: { principal: string; decision: string; reason?: string; recorded_at: number }[];
  landings: Landing[];
  repairs: Repair[];
  review_classes: ReviewClasses;
  break_glass: BreakGlassRecord[];
  gates: Gates;
};

/** Ready or not, with what landing still needs in plain words: the review class only when
 * it is known, approvals only when the policy requires them. */
export function GateSummary({
  gates,
  classes,
  notes = [],
}: {
  gates: Gates;
  classes: ReviewClasses;
  /** More of what landing needs, beyond the gates. */
  notes?: string[];
}) {
  const label = classLabel(classes);
  const lines = [
    label && `${label}${gates.auto_approved ? ' · auto-approved by policy' : ''}`,
    !label && gates.auto_approved && 'Auto-approved by policy',
    gates.approvals_required > 0 &&
      gates.approvals >= gates.approvals_required &&
      `Approved (${gates.approvals} of ${gates.approvals_required})`,
    ...gateNeeds(gates),
    ...notes,
  ].filter((line): line is string => Boolean(line));
  return (
    <>
      <h3>{gates.ready ? 'Ready to land' : 'Not ready to land'}</h3>
      {lines.length > 0 && (
        <ul>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Approve, and Reject with a required reason. */
export function ReviewButtons({
  disabled,
  onReview,
}: {
  disabled: boolean;
  onReview: (decision: 'approve' | 'reject', reason?: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => onReview('approve')}>
        Approve
      </button>
      <input
        aria-label="Rejection reason"
        placeholder="Reason to reject"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        type="button"
        className="danger"
        disabled={disabled || !reason.trim()}
        onClick={() => onReview('reject', reason)}
      >
        Reject
      </button>
    </>
  );
}

export function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return conflicts.map((c) => (
    <section key={c.path} className="source-file" aria-label={`Conflict in ${c.path}`}>
      <header>
        <code>{c.path}</code>
        <span>{c.kind.replace('_', '/')} conflict: resolve in a new commit</span>
      </header>
      {c.marked && <pre>{c.marked}</pre>}
    </section>
  ));
}
