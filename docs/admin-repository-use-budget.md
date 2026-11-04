# Admin repository use query correction

Written before implementation, 2026-11-03.

The served Admin Repositories report returns `query_failed` because its pushed-byte
conditional combines a Double Analytics Engine column with an Integer zero.
The SQL API rejects that expression before it reads rows. Repository Insights uses
a different query and is not evidence that this aggregate query works.

Keep the same weighted sums, action filters, 7/30/90-day windows and ordering.
Use a Double fallback in the pushed-byte conditional; do not mask errors as zero
usage or change credentials. Budget remains two parallel bounded SQL queries and
one D1 name lookup, at most 50 candidate rows per query and 10 displayed per list.
There are no new requests, caches, resources, migrations or background work.

Verification: reproduce the SQL type rejection in a targeted provider-contract
regression before fixing it, retain failure-vs-empty report behavior, and verify
both rankings over 7/30/90 days against the real read-only SQL API. Served local
checks cover honest empty/error states. After root deploys dev, validate each
actual Admin range through the current owner session; source/local success alone
is not deployed acceptance. No models, workload, repository mutation or token
changes are needed.

Reference: [Workers Analytics Engine conditional functions](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/conditional-functions/)
and [numeric literals](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/literals/).

Local/source acceptance: all three range regressions failed with `query_failed`
before the literal correction and passed afterward (18 targeted report cases).
The exact changed-source SQL for both rankings returned HTTP200 over7/30/90 days
with the existing scoped read token. Actual served frontend empty/error fixtures
passed wide/375px, both themes, keyboard range changes and Retry; all eight
screenshots were inspected. Fixture states are not backend deployment acceptance.
