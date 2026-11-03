# Managed-agent recorded usage

Workspace Runs and each agent's page summarize their already loaded managed-run
records. The existing managed API freshly authorizes the workspace owner and reads
only currently owned repositories. The platform remains an ordinary API provider;
it does not gain agent scheduling, billing or analytics policy.

## Request and payload budget

No additional browser, authority, repository, ledger or provider request. Keep the
existing latest 100 runs on workspace Runs and latest 50 on an agent's page;
filtering an agent uses the existing route and server filter. Aggregate those same
rows in linear time and display the coverage beside Usage. These figures are not
all-time or invoice totals. No new database, schema, cache, backfill or feature
switch is needed because no new server path or read work is introduced.

Show recorded input/output tokens, model calls, execution time, recorded cost and
run outcomes. Provider usage recorded by the gateway includes cached input tokens.
Calls without reported usage are absent from the run's token/call counters; runs
with no reported call show unavailable tokens, never invented zeros or messages.
Execution time is measured container time, not human hours or inferred savings.
Retries retain cumulative usage but report the current run outcome. Costs here
come from run records, not a substitute for billing history or credit balance.

Empty runs stay a shared empty state, not four zero cards. Missing/partial usage
is labelled; failed admission clears usage. Loading and errors use the existing
shared states with retry; the known four-card layout reserves empty values while
loading. Key workspace/agent views so a new scope cannot display
the preceding scope's loaded records while its request is pending. No identity or
authorization response is cached.

## Validation

Reproduce absent summary coverage first in frontend tests. Check mixed outcomes,
partial/missing token history, recorded execution/cost, bounded rows, agent filters
and run detail. Workerd tests use real managed Durable Object records and a fake
platform authorization adapter; owner, reader, foreign-workspace, no-longer-owned
repository and permission revocation boundaries must hold. No paid model or live
run is needed. Inspect the production-built served app at 375px and wide, both
themes, full/empty/loading/error/denied states and keyboard filtering. Root owns
dev deployment and subsequent validation against actual retained run history.
