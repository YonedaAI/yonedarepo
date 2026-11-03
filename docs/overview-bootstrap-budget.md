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

Test old-server fallback, empty/import/error states, alias/cell forwarding, selected
branches and commits, min_version, public privacy, private denial, restricted paths,
quarantine, revocation and cancellation. Compare at least three cold/reload/picker
runs of the actual served page, with section completion, payload bytes and server
phases. Report misses plainly. No deployment or paid inference is part of this slice.
