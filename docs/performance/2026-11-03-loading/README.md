# Dev browser loading — 2026-11-03

Repeat repository views improved. Fresh loading remains above the 500 ms target.
This dated snapshot records frontend `b19ca6ce` with backend `f7e5a6e3`, against
`f87f7baf`. Later unrelated changes are not represented by these measurements.

[Infographic](browser-loading.png) · [Editable SVG](browser-loading.svg) ·
[Sanitized measurements](browser-loading-data.json)

## Method and request budget

One authenticated Chrome client at 1440×1000 used one retained real-history
repository. Each condition has three samples: fresh browser context, reload,
and repeat document navigation. Two pages give 18 document loads per cohort.
A separate three-round run used sidebar Files navigation and the repository
picker from Agents, giving three returns per path. Normal caching stayed on;
no interception, throttling, writer burst, compaction or paid inference was
invoked. Browser contexts were fresh; backend/CDN caches were not controlled.
Observed ingress was MCI and API placement IAD. This does not locate the human
or prove worldwide performance.

Usable Overview means header, latest commit and rich README are ready. Plain
README fallback is not counted as rich readiness. Activity/contributors and
visible images have separate timestamps. Agents readiness means its cards
appear. These are browser timings, not monitor alert or Worker latency values.
Repository refs remained unchanged within and across the measured cohorts.

The changes remove public-site code from workspace startup, load renderer code
in parallel, retain fresh admission, and remove one published-head lookup for
eligible Overviews. Tree RPCs can remain. Offscreen repository images issue no
request until visible. There is no IndexedDB/private body cache or cached
authorization. Each image revalidation still checks admission. This report and
its renderer make no platform requests.

## Document loads

Milliseconds, minimum / **median** / maximum, three samples per cell.

| Readiness | Before | Current |
|---|---:|---:|
| Overview, fresh | 974 / **1,008** / 1,714 | 709 / **730** / 1,832 |
| Overview, reload | 464 / **538** / 648 | 471 / **494** / 638 |
| Overview, repeat document | 498 / **655** / 913 | 490 / **492** / 523 |
| Agents cards, fresh | 950 / **1,232** / 1,380 | 908 / **1,141** / 1,246 |
| Agents cards, reload | 609 / **826** / 835 | 572 / **599** / 812 |
| Agents cards, repeat document | 602 / **674** / 827 | 581 / **604** / 706 |

The first sampled fresh Overview still took **1,832 ms**. Fresh 500 ms readiness
is not achieved. Reload/repeat medians improved, but ranges overlap and this
sample size does not establish every navigation is faster.

## Activity and images

The complete Overview includes activity and contributors. Its fresh median
was **1,142 → 1,165 ms**: no improvement. Reload was **1,107 → 1,044 ms**, and
repeat document navigation **1,001 → 872 ms**. Deferring this work lets core
content appear first; it does not make the optional work disappear.

Current visible-image medians were 1,360 ms fresh, 768 ms on reload and 821 ms
on repeat document navigation. The current document harness also checks visible
placeholders, so these image timings are not used for a before/after claim.
The separate SPA image harness is unchanged across the comparison below.

| Return to Overview | Before core | Current core | Before visible images | Current visible images |
|---|---:|---:|---:|---:|
| From Files | 520 | 331 | 967 | 667 |
| From Agents | 364 | 306 | 748 | 615 |

All 12 image responses on the six final Overview returns were HTTP 304, with
roughly 0.7 KB of headers each and no image body transfer. The PNG that previously
returned 200 after leaving Files now reuses its cached body in all three tested
loops. Canceling a genuinely visible in-flight image can still evict a browser
cache entry; this slice does not promise otherwise.

## Build and deployment evidence

A same-base controlled build isolated the public-site split: workspace startup
JavaScript, including its static shared chunks, fell from **335,613 to 226,070
gzip bytes (32.6%)**. The entry alone is not the full closure. Public startup
was 335,613 → 339,387 gzip bytes and preloads its separate code/styles. These
local compression measurements are separate from Cloudflare wire encoding.

The initial preload script followed CSS. Real Chrome then waited for CSS before
requesting the renderer. Holding CSS reproduced that defect; putting the existing
script before styles fixed it. Final fresh renderer requests began at 226/233 ms
while CSS finished at 524/473 ms in the two normal samples. The intermediate
809 ms median and every raw numeric sample remain in the JSON.

The full dev rollout passed its smoke at `f7e5a6e3`; the head-only correction
then passed frontend health at `b19ca6ce`. Both 18-load cohorts completed with
zero app page errors or failed API responses. Ordinary browser/fork functional
gates also passed on this pair. Resource-console noise from the test traffic
header/beacon, missing avatars and intentional deleted-fixture requests is
recorded privately; it is not reported as zero console errors. Production was
not deployed. There is no Entire or ForgeMark throughput result here.

## Remaining latency

In two normal pre-head-fix samples, API completion was 543–567 ms after
navigation. The paired API duration was 350–352 ms; its backend timing header
reported 128–135 ms. The remainder includes forwarding, runtime/CPU and network
work not fully covered by that timer. It cannot be assigned to secrets, a
specific region, or one hop from these observations. Workers clocks also
advance after I/O, so CPU profiling needs separate evidence. See the official
[performance and timers documentation](https://developers.cloudflare.com/workers/runtime-apis/performance/).

Measure the outer request boundaries and the slow initial authority calls
before changing placement again. The client-side improvement is real in these
samples; the remaining fresh-load and optional-activity delays are still open.

## Reproduce the figure

From the repository root, using the pinned dependencies and system Chrome:

```sh
node tools/render-browser-loading.mjs --data docs/performance/2026-11-03-loading/browser-loading-data.json
node tools/render-browser-loading.mjs --data docs/performance/2026-11-03-loading/browser-loading-data.json --check
```

The renderer checks numeric text, source sample counts, text bounds and PNG
dimensions. SVG generation is deterministic; PNG pixels depend on installed
fonts/Chrome. Both full and reduced-size images were visually inspected.
Private URLs, account names, repository ids, credentials and raw logs are
excluded from these published artifacts.
