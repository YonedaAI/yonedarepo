# Overview core readiness

Request budget, written before implementation, 2026-11-03.

The current combined response waits for the optional 200-commit activity read.
A live retained-history response held 124,191 decoded bytes: 30,403 activity,
29,816 README and 60,270 refs. These are one observed payload, not global totals.
The three normal-cache reload samples after early reads were 536/712/941 ms;
the startup change does not remove the history read from this request.

## Proposed bounded path

Behind `OVERVIEW_DEFER_ACTIVITY`, keep fresh admission, status, selected tree,
latest commit and README in the core response. Do not call `repo_log` there.
An explicit activity request descriptor names the already selected ref, commit
and version. The browser reads that exact historical window after core content
is usable; current authorization and quarantine checks still run on that read.
Use the existing log endpoint and its existing 200-commit bound. No new storage,
index, persisted browser cache, write operation or background model is added.

Budget: one existing core HTTP request, no extra core authority/status read;
one deferred activity GET, at most 200 commits, with fresh admission. Existing
fork/restricted and switch-off behavior remain on their present path. Unknown
or failed sections must not invent statistics or a successful read. The chart
stays above README. The initial implementation reserved space for the chart
and six contributors after loading, including empty/error results. The compact
layout correction below supersedes that geometry: settled content uses its
natural height. No layout redesign.

The independent toolbar fix removes the nested facts row's bottom margin in
PageToolbar; its labels remain compact and align with the branch control.
Check wide/375px, themes, wrapping, focus and no horizontal page overflow.

## Acceptance

A held history read cannot delay the core response. Deferred activity is pinned
to the captured tree and transaction version even if the branch changes. Current
access revocation still denies the deferred read. Empty/missing/error/ref-switch
states remain correct. The off switch preserves the existing full envelope.
Measure real Chrome reload and in-app navigation with normal caching before and
after deployment: at least three rounds, min/median/max, request starts, server
timings, bytes and errors. Report regressions and network variability. No writer
or load tests are part of this slice.

## Local verification

The switch-on core performs one status read and zero history reads. A held
history operation cannot hold its README. A real Worker fixture reproduced a
landing between admission and tree selection: the first patch mixed versions.
Core selection now pins admission's version as well as the deferred request;
its README, commit and landed metadata stay on the same captured version.
Explicit commit selectors and a higher read-your-write floor keep the old path.

Targeted results: 28 Worker tests, 15 browser component/model tests and the
shared dev/prod switch test pass. TypeScript, touched-source Biome, Rust fmt,
xtask Clippy, generated-config checks and the frontend production build pass.
The build retains its existing large main-chunk warning.

Sixteen local served states cover 1440/375px, light/dark and full/loading/empty/
error activity. The badges share the branch selector's vertical centre on the
wide row, keyboard focus works, and there is no horizontal page overflow.
That earlier fixed reserve kept the README position unchanged, but the live
browser gate subsequently found a 96px blank gap before the README with one
contributor. These fixtures simulate API results; they do not demonstrate
deployed latency.

Deferred activity currently uses the existing full log response rather than
its compact inline memo. Live comparison must include total bytes and activity
readiness, alongside core readiness, before claiming a general speed gain.
No production rollout or writer/load test is represented by these results.

## Compact layout correction

Contributor rows now use the existing 20px avatar and chrome line height, with
no extra row padding or list gaps. Six rows and the history-limit note fit
beside the 190px chart. Pending deferred activity reserves 190px on desktop
and 394px on mobile; settled old/empty/error results collapse naturally.
No HTTP requests, API contracts, authorization or repository state change.

The unchanged browser helper requires at most 32px between activity and README.
The served component regression covers five settled states at 1440px/375px,
light/dark, held loading, keyboard focus and page overflow. All 20 settled
states meet that 32px bound, with no page errors or horizontal overflow.
The normal desktop chart has zero README movement, with either one or six
contributors. Loading movement is not fully solved for other results:

| Result | Desktop README movement | Mobile README movement |
|---|---:|---:|
| Six contributors and history-limit note | 0px | -0.6px |
| One contributor | 0px | -133px |
| Old history, six contributors | -10.6px | -142.2px |
| Empty activity | -167.6px | -371.6px |
| Activity error | -140px | -344px |

Negative values mean the README moves upward when the optional response
finishes. These are local fixture geometry measurements, not a field CLS
score or a deployment claim. Keeping a large settled blank area is not an
acceptable way to hide that movement. Eliminating the remaining shifts needs
a bounded initial activity summary that knows the required layout before the
optional history request; that backend change is outside this CSS repair.
