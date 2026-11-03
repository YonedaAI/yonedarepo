# Recent versions request budget

The retained MiMo repository has 503 versions. Landed versions and the Files version
picker currently fetch the earliest 500 full entries (204,293 decoded bytes), so
versions 501–503 are missing even while the heading says version 503.

Behind `RECENT_VERSIONS`, advertise a dedicated recent-versions read in fresh browser
metadata. Rust selects a newest-first page of at most 50 entries, with an exclusive
older cursor and a snapshot version/history chain. Concurrent writes do not reshuffle
older pages; a reset that reuses version numbers refuses the old cursor. Retain the
CLI's default ascending `after` protocol unchanged. Archived entry pages read one
sealed segment and verify its existing digest/chain.
If the snapshot anchor has since been archived, verifying it may read another segment.

Landed versions renders at most 50 rows. Load older and Newer replace the page;
only cursor metadata is retained, and every navigation reads freshly authorized data.
Files
initially reads only compact version/kind/time choices, never full touched paths or
read sets. Table rows also omit unused intent/read-set fields. An explicitly selected
old version remains an option even before its page
loads. Older choices remain reachable. Initial goals: one recent read per view,
at most 50 rows, compact choices under 8 KiB on the retained history. Measure actual
bytes and readiness after integration rather than claiming a latency improvement.

Old/off servers use the existing ascending `after` windows, with validated bounds
and a chain anchor; no unsupported descending query may silently label an old page
as newest. Legacy fragments may need up to 50 strictly advancing window reads plus opening
and closing anchor reads. Rebasing stale initial metadata can need one extra anchor
read. Normal new-server pages use one request. All reads retain fresh server
admission, path redaction and principal
privacy. No viewer/access state or unfinished network I/O is shared across requests.

Test more than 500 versions, exact older selection, forward writes, reset/chain
changes, archived boundaries, old/off compatibility and denial. Validate the served
controls at wide and 375px in light/dark without submitting mutations. Root owns
live retained-history and 1,000-writer evidence; this slice does not deploy or run
provider calls.

Local evidence (2026-11-03): 6 new Rust cases, 18 compaction and 16 path-grant
cases pass. The own Wasm passes 19 targeted workerd cases, including a reproduced
400 `TXLOG_ARCHIVED` failure when a held snapshot and its older page occupy two
segments; naming both dependencies before the one hydration retry fixes it.
37 frontend and 15 environment parity cases pass. Both generated environment
configurations match their specs. Types, formatting, Clippy, boundary, layer,
line and production size gates pass; no allowance was raised.

Seven served Chrome scenarios pass: 50-row paging/Newer, explicit old selection,
empty, error/Retry, legacy server, admission denial and navigation cancellation.
Wide/375px light/dark screenshots were inspected. Selecting a long native option
initially caused 426px page width at 375px; wrapping the version controls fixes it.
The picker still offers the old selection before its page loads, and no scenario
requests the former 500-entry payload. Private scripts, requests and screenshots
are in `.local/implementation-20261103/recent-versions/`.

This is local validation, not deployment or retained-history latency proof.

Legacy reset-race follow-up: establish the snapshot chain before the first window
and check it again after every page is collected. This rejects a reset between an
older-page anchor and its data, and a reset between first-page archive fragments.
Forward writes may advance the server head while the anchored snapshot stays fixed.
A closing admission denial returns no collected rows. The existing ascending old
protocol has no atomic multi-request snapshot; these are optimistic fences, not a
new server guarantee. The advertised recent endpoint remains one authority read.

Both reviewer repros failed before the fix and pass afterward. Fourteen version
unit cases (42 targeted frontend cases total) pass, as do five served Chrome cases
for stable forward writes, older reset, fragmented reset, closing denial and
cancellation. Changed/denied histories clear the table, and reset rows never paint.
Wide/375px light/dark screenshots were inspected. Private evidence is in
`.local/implementation-20261103/legacy-version-fence/`. No deployment was performed.
