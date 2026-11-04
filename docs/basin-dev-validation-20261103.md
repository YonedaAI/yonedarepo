# Basin change-history validation

Checked on dev, 2026-11-03, 21:17–21:20 UTC. The primary backend's existing
change-history pipeline works with real repository events. Production and EU
backend coverage are not accepted by this check.

## Observed results

| Check | Result |
|---|---|
| Pipeline and catalog | Pipeline running; destination catalog active |
| Stream schema | All 34 fields match the committed schema, including types and requirements |
| Stored rows | 3,713 physical rows; 3,710 distinct event keys |
| SQL tools | Status, landed-commit lookup, hourly, rates and N9 queries succeed |
| Existing Commander repository | 14 streamed versions and five landings match the authority |
| Cursor | Version 15; 14 records sent; zero send failures; no outstanding claims |
| Decode errors | Zero observed for this pipeline in the preceding 72 hours |
| Dropped events | No error groups returned in that 72-hour query; its result limit was not reached |

The comparison covers versions 2 through 15. Each version has the same event
kind and commit as the repository's authoritative log. There are no missing,
extra, incorrect or duplicate records in that window, and the merged-record
counts agree. The final approved main commit appears once at version 15, matching
the landed change and the authoritative log.

Version 1 precedes this repository's first streamed event. Cursor initialization
starts at the existing head; it does not backfill earlier history. No logged
gap falls inside the comparison window. Physical duplicates elsewhere in the
table are compatible with at-least-once delivery; queries deduplicate by event
key. These observations do not establish completeness for every repository.

## Regional coverage

The deployed primary platform Worker has the change-log stream binding. The EU
platform Worker does not. The generator deliberately removes pipeline bindings
when constructing that backend, so this is a declared coverage gap rather than
a stopped pipeline.

The existing catalog has the provider's default jurisdiction. EU analytics needs
a reviewed regional destination and residency decision before binding it; the
successful primary check does not establish EU-only storage. Production remains
unbound and was not validated here.

## Method and limits

This was a bounded read of existing data: six SQL queries, pipeline/stream/sink
and catalog metadata, repository status/cursor/log/change reads, and four metrics
queries. No writer test, new fixture, history reset, backfill, login, provider
model run or resource change was needed.

The live stream schema comparison ignores JSON property order but preserves
field order, field names, types and required flags. Private evidence retains the
exact repository, commit, event keys, query results and comparison. Those
identifiers and account details are excluded from this report.

This check does not satisfy the seven-day soak, cost, erasure, regional coverage
or production promotion requirements in the
[Basin soak budget](load-testing.md#basin-soak-budget). Keep the existing
[Basin runbook](runbook.md#basin-analytics) as the operational procedure.
