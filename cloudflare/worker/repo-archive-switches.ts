// Switches of the archive plan's first stage (docs/global-scale-plan.md, item 3) that change
// what the authority stores. Each is off unless set to `on`, and readers understand both
// forms either way, so a switch can go back off. A binary from before these switches cannot
// read what they store: docs/runbook.md says when each may be turned on.
type Switch = { CHECK_EVIDENCE_ONCE?: string };

/** Command keys only `archiveSwitches` may set (never from client input). */
export const ARCHIVE_SWITCH_KEYS = ['_check_evidence'];

/** What every command to a repository carries. */
export const archiveSwitches = (env: Switch) =>
  env.CHECK_EVIDENCE_ONCE === 'on' ? { _check_evidence: 'once' } : {};
