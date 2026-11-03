# Controlled regional performance baseline

Status: proposed protocol, 2026-11-03. No new experiments run by this change.
Use this before deciding which placement or indexing optimization is faster.

## Correct the earlier comparison

The earlier [placement infographic](performance/dev-loading-placement.png)
changed API execution placement while the retained repository authority stayed
in US East. The rejected Smart Placement sample ran API code in Mumbai against
that US data. It did not move the complete web/API/data stack near a person.

Those measurements remain valid observations of those runs. They do not show
that putting both compute and data near a user is slower. The short Smart
trial also does not establish its steady-state behavior or explain why its
optimizer selected Mumbai.

The later [six-region validation](global-routing-validation-20261103.md) proved
regional API execution, retained-state correctness and bounded write/read
correctness. Its browser connection had a roughly 100 ms transport floor even
for a tiny cached asset. Earlier and later runs did not control connection or
asset-waterfall conditions, so their difference is not a code-only regression.

Do not use either figure as proof of worldwide speed. Keep the old snapshots
and attach this limitation rather than replacing historical values.

## Questions to isolate

1. What does moving API execution cost when repository data stays fixed?
2. What does placing a new repository near its actual creator improve?
3. Which bytes and indexes remain remote despite nearby API/authority placement?
4. What do local immutable copies improve after current admission checks?
5. Is the visible wait document/asset startup, domain work, storage or transport?

The frontend stays globally served in the main experiment. Do not bundle a
frontend pin, an API routing change, a data move and an indexing change into
one comparison. Measure any frontend-only change in a separate pair.

## Inventory before testing

For every condition record actual observations, separately from configuration:

| Item | Record |
|---|---|
| Client | Real country, ingress colo, browser/runtime, connection and VPN state |
| Frontend | Build/config identity, asset hashes, placement and cache behavior |
| API | Selected entry, serving API, placement hint and observed execution colo |
| Mutable authority | Repository/account authority locations and stable identities |
| Object bytes | Source of each measured read: hot object, nearby copy, R2 or artifact store |
| Indexes | Manifest/content identity, readiness, segment location and cache state |
| SQL discovery | Storage cell and observed primary/replica metadata where exposed |
| Version | Source revision, application-code fingerprint, environment flags and dependency versions |

Six API regions do not imply six complete local storage stacks. Today the
explicit authority/storage cells are US and Europe. Objects created elsewhere
can use nearby location hints while discovery, object bytes or search segments
still use a remote configured store. If a tier's physical location is unknown,
label it unknown; do not infer it from the API's colo or a bucket's name.

Use provider invocation analytics to corroborate Worker execution. It is
independent of request-client metadata and an outgoing trace. For repository
objects, record their observed location too. Neither observation proves that
all associated bytes or account state share that location.

## Paired conditions

Use the same client connection and application code within each pair. The
following conditions isolate different questions; do not collapse them into
one “pinned versus global” bar:

| Condition | API | Repository/storage | Purpose |
|---|---|---|---|
| A: existing authority baseline | Close to the existing authority | Same fixed repository | Reference for existing repositories |
| B: nearby API only | Close to the requesting client | Exactly the same repository as A | Isolate repeated remote authority/storage calls |
| C: eligible local reads | Same as B | Same authority, with validated nearby immutable copies | Isolate copy benefit and first-fill cost |
| D: new nearby repository | Close to the client | New fixture whose actual authority and required storage tiers are nearby | Test the complete local-data case where supported |

A/B/C must preserve the repository and selected content revision. For D, use
dedicated pure OSS fixtures imported from the same pinned Git pack, matching
commit/tree/content and history size. Native transaction-history workloads also
need matching seeded event counts and policy; label any remaining differences.
Retained owner repositories are read-only comparison subjects. Never move,
delete, re-import or repack them to manufacture a baseline.

Start with a US and a real European client because both storage cells exist.
Include a cross-region reader of each fixture. Add Asia and the other regions
only when a real client and the relevant storage tiers can be observed. A
Frankfurt Worker invoked from a US client preserves original geography and is
not a substitute for a European creator. Do not fake `Request.cf` or caller
headers in a live placement result.

For API-only A/B, the same real client can address the existing regional API
aliases directly with its normal credentials. For browser A/B, keep one
same-origin frontend and vary only a reviewed dev service binding/routing flag
between paired waves. The existing `REGIONAL_API` off/on path is a candidate
control for fixed authority versus caller routing; verify its exact behavior
and observed destination first. Use `cargo xtask deploy --env dev --front` only
when the change is genuinely front-only. Record the configuration diff; do not
retarget requests with browser interception or expose a public routing override.
Do not create a third environment or change production for the experiment.

With the current bindings, a real European client reading a US repository gives
a useful off/on contrast: IAD versus FRA. A US client reading that US repository
gets IAD in both cases; an EU repository may forward to FRA in both cases.
Those are valid controls but cannot demonstrate a placement benefit. Check the
serving API and provider execution colo before treating a pair as a contrast.

## Cache and index states

Keep these conditions separate:

- Fresh browser context: empty browser cache; backend/CDN may already be warm.
- Warm browser reload: same context, cached matching immutable assets.
- In-app repeat navigation: existing app instance, with fresh admission rules.
- Ready persisted index, cold local segment/blob cache, and a distinct query.
- The same exact query with a completed-result memo hit.
- Missing/partial index or first regional fill: separate recovery measurement.

Do not call a fresh browser a cold database. Do not silently purge shared caches
or alter retained repositories. Use new dedicated fixture identities for safe
cold-artifact measurements; record whether storage was actually cold.

Playwright request routing disables browser HTTP caching. Do not use intercepted
sync/API requests in a purported warm-cache baseline. Use dedicated configured
test accounts, exercise normal behavior, and record automatic requests. If
interception is needed for a functional check, label it and exclude those runs
from cache/performance comparisons.

## Workloads and measurements

Use the retained large-history Overview as the user-visible reference and a
matching dedicated fixture where state must differ. Measure Overview, Files,
Versions, Agents, repository search and account search independently.

For every request capture wall time, server phases, status, bytes and destination.
For each page capture document TTFB, JS/CSS start/end, first API start, header,
usable files/README text, rich Markdown, visible images and layout shifts.
Keep activity and contributors above the README without blocking core content.

For search separate discovery, current admission, segment reads, candidate blob
reads, exact confirmation and ranking. Use a fixed query set containing distinct
queries, exact repeats, no matches, short terms and restricted paths. Compare
complete result sets at the same revision; a faster partial answer is not a win.

Declare the numerical request, byte and wall-time budget for each workload
before implementing its optimization. Separate the fresh authorization cost
from optional decorations and immutable content reuse. Never improve a timing
by serving private data before admission or by hiding failed/missing work.

## Run procedure

1. Save a private manifest of source/config, real client geography, stable fixture
   state, store locations and cache/index conditions. Check health revisions.
2. Freeze application source, policies, fixture content and background load.
   Record normal scheduled work and reject a pair contaminated by a deploy,
   coding run, load burst, unrelated fixture mutation or network/VPN change.
3. Use at least three paired rounds, alternating A/B then B/A. For a release
   decision, collect 30 navigations per condition per region across those rounds.
   Keep first-fill/cold recovery samples in their own series.
4. Publish sample count and min/median/max for every series. Report observed p95
   only with its sample count; three samples alone cannot establish a tail SLO.
   Retain raw failures and outliers, with any excluded pair and reason recorded.
5. Compare identical-query memo hits separately from distinct-query index work.
   Repeat only when a source/config change or unresolved failure justifies it.
6. Run the required three independent 1,000-writer bursts on the final selected
   dev candidate, including exact-content readback, real-history reads and
   server timing. Retain fixtures and revoke temporary tokens afterwards.
   Keep bursts separate from interactive page timing.

Use the same geography observation immediately before and after each round.
No models are required for this benchmark. Do not run heavy acceptance on prod.

## Decision and publication

Choose the placement and index path per workload from the measured critical
path. Existing authority-heavy work may belong near its authority; new local
repositories and immutable reads may favor the reader's region. This is not a
reason to pin the whole frontend or recreate existing authorities.

A candidate passes only with equivalent content/access/revision results and
repeatable improvement in the paired workload. Report regressions too. If the
benefit is smaller than observed run-to-run variability, call it inconclusive.
Do not infer an all-region result from one country or an API health endpoint.

Publish a new dated JSON/SVG/PNG snapshot under `docs/performance/`, containing
source/config identity, actual placement, cache/index conditions, sample counts,
all latency ranges, error counts and the limited conclusion supported. Retain
previous figures. Account identifiers, repository IDs, credentials and private
monitor details stay in `.local/`.

Dev validates the candidate first. A later production promotion still requires
the final-tip full kit and the existing ship/watch/smoke pipeline. This document
does not approve a production configuration change.
