# Managed Agents list request budget

The list is usable when its real agent cards, latest states and credit are present,
and search/filter controls work. The toolbar alone is not completion. Three fresh
Chrome contexts on dev measured 868 / 913 / 1,197 ms to cards; the managed list GET
itself took 666 / 697 / 837 ms. The baseline intercepted automatic sync POSTs with
`connected: 0` to keep existing agent/repository settings unchanged. It does not
prove real sync completion or timing under sync contention.

Current server order: parallel repository/org/session discovery, then each agent's
settings/meta followed by run reads, then credit. The personal session unnecessarily
reads optional handle/avatar details. The list needs repository discovery to filter
its enabled repositories and return the setup choices, but a fresh personal-session
or organization-owner answer can establish ownership sooner.

With FAST_AGENTS_LIST on, keep all authority requests fresh. Begin managed read state
and credit once a current personal-session or organization-owner proof succeeds,
while repository discovery completes. Return no payload until the original full
access decision and repository listing both succeed. Preserve the existing legacy
owner-repository fallback. A request without positive owner proof starts no managed
state/credit reads. Fetch session summary for this proof; retain the old full-session
path and old ordering with the switch off. No permissions, model calls, sync actions,
agent settings, cached credentials or payment behavior change.

Budget: one browser list GET after session admission; three public platform ownership
reads, started together; existing managed state reads and credit overlap once owner
proof is known. No extra reads, shared unfinished I/O, persistent response cache or
new database query. Error and cancellation scopes stay request-owned. Record server
phases for access, agent state, credit and total. Keep payload/layout unchanged.

Prove early valid-owner work with a held repository discovery request, deny readers
and foreign workspaces before managed reads, keep legacy ownership and switch-off
behavior, propagate late listing failures without a partial payload, and prove a
held/cancelled request does not block a later request. Validate the served page at
wide/375px in light/dark, keyboard search/filter, plus full/loading/error states.
The root owns dev deployment and at least three fresh live measurements afterwards.

Local validation: 38 targeted managed tests across five files, 16 infrastructure
tests and six boundary/logging checks pass. Type/style, Rust format/xtask Clippy,
the worktree's Wasm and frontend builds, generated config parity, and size/line
budgets pass. Live unchanged UI checks cover wide/375px, both themes, keyboard
search/filter, loading, empty filtering, and error/retry. Cards become usable while
automatic sync is deliberately held; no actual sync or provider action was run.
The new backend path still needs deployment and live phase measurements.
