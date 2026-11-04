# Overview bootstrap request and payload budget

The acceptance target is the owner's retained real-history Overview, reached by a
cold named URL, reload and repository picker. Useful content means the actual
header, selected tree, latest commit, activity, contributors and README text; a
container or loading label is not completion. Keep activity above the README.
Record visible image completion separately, without blocking text on decoding.

Today the named URL chains resolve → status summary → tree → README. The resolver
already checked fresh repository status for privacy; summary repeats it. Each HTTP
request also repeats credential admission. Latest commit and activity begin only
after the tree. The named page's nine complete-content observations were:

| Entry | Three runs, ms (min / median / max) |
| --- | --- |
| Cold named URL | 1,255 / 1,744 / 3,126 |
| Reload | 1,426 / 1,431 / 1,562 |
| Repeat named navigation | 1,330 / 1,438 / 1,646 |

These include real latest/activity/contributor/README content, not just containers.
The earlier picker observations were 574 / 388 / 387 ms for the header and
1,611 / 821 / 833 ms for README text, with zero repeat asset bytes.

With `OVERVIEW_BOOTSTRAP=on`, `summary=true&overview=true` asks for one response
containing fresh status, selected root entries, latest commit, activity (at most
200 commits) and the selected README. The named resolver reuses the status and
handle it already authorized. The id form retains its normal summary fields.
Old servers or the switch off omit the additions: the browser uses existing calls.

Budget: one client request before useful Overview content, one credential admission,
one fresh status privacy/access decision and one selected tree. After selecting the
commit, README, latest detail and activity run independently in parallel. Pin every
content read to that commit; retain grant checks, quarantine and landing-version
floors. Apply principal privacy once to the whole response using its fresh viewer.
Never wait for shard storage diagnostics. Keep optional section errors local.

Goals, to measure rather than promise: useful cold content below one second and
repeat navigation below 300 ms. Target the acceptance page's JSON below 512 KiB;
record its actual size and misses. Existing tree/file limits remain in force, with
README inline content bounded by the existing 8 MiB file-read limit. The activity
limit remains 200; no unbounded history or image blobs enter the bootstrap.

Start without a new persistent cache. A navigation-scoped response may be handed
to the page only for that exact route, viewer and refresh generation. No history,
localStorage or IndexedDB metadata cache; no cached access or mutable refs/checks.
If measurements justify immutable memory caching, key it by repository and commit,
with current grant/quarantine validation before display, and bound retained bytes.

## Completed activity cache

The first live bootstrap's named completion times (min / median / max, ms) were
908 / 973 / 3,167 cold, 760 / 804 / 941 on reload and 681 / 1,003 / 1,116 on repeat
navigation. The 300 ms repeat goal remains unmet, and the first cold stall persists.
Activity still spends 158–347 ms on a 200-commit log; warm README reads spend about
104 ms before a 2 ms edge hit. Decoded JSON is 124,083 bytes (41,930 transferred).

This slice remains inside `OVERVIEW_BOOTSTRAP`. After fresh status admits the caller,
cache only completed compact activity, never pending I/O, status, refs, viewer,
latest checks or errors. Keys include repository/store, exact selected commit/ref,
the actual log version, fresh history chain and quarantine epoch. Restricted grants,
forks and histories with no chain bypass it. Fresh status obtains the chain alongside
version from the same existing SQL query, without a migration or extra query.
Fresh principal redaction still runs for each response. A version race populates
no key until a later admission observes that version's chain. Re-importing the same
commit under reused version numbers changes the chain and cannot reuse old activity.

Bound the isolate cache to 128 entries and 4 MiB total, with a 256 KiB entry cap.
Legacy activity missing author metadata bypasses storage because author backfill
does not advance the log version. Cache hits perform zero log RPCs. Misses retain
one log RPC and the 200-entry limit; no extra network call is introduced. Reuse the already
selected root for the Overview README walk instead of resolving that commit again,
while retaining the same path/grant and blob quarantine checks. Picker metadata
continues to render progressively. Global object-tier ordering is outside this slice.

Measure actual named/picker content again after integration; these content savings
alone cannot guarantee 300 ms while fresh admission/name resolution remain serial.

Test old-server fallback, empty/import/error states, alias/cell forwarding, selected
branches and commits, min_version, public privacy, private denial, restricted paths,
quarantine, revocation and cancellation. Compare at least three cold/reload/picker
runs of the actual served page, with section completion, payload bytes and server
phases. Report misses plainly. No deployment or paid inference is part of this slice.
