# Repository image revalidation

Budget written before implementation, 2026-11-03. Repeat navigation to the
retained Overview transferred about 438 KB for two image JSON responses each
time. After the navigation fix the whole content was ready in 470/480 ms median
(two entry paths), while visible images took 932/964 ms. Each is three samples
from one real client, not a global result.

Opt into browser HTTP revalidation only for `GET .../blob?revalidate=image`,
behind `REPO_IMAGE_REVALIDATION`. Keep the existing JSON contract, repository
read, current authorization, path grant, quarantine and privacy checks. Those
must finish successfully before any 304 decision. Use an ETag of the exact JSON
representation and `private, no-cache, must-revalidate`; vary by Cookie and
Authorization. Do not cache errors, text, missing/oversized bodies or any
request when the switch is off. No public/shared CDN cache, stale fallback,
IndexedDB, new storage, model or authority decision is introduced.

Budget: one existing authorized blob request per visible image. On an unchanged
response a private browser cache may reuse its body after fresh revalidation;
server-side object lookup cost is unchanged in this first step. Keep ordinary
blob requests no-store and never let an ETag bypass current refusal.

Acceptance: RED then GREEN conditional-body behavior using real workerd repos;
changed content gets a new body; revoked and path-restricted access, quarantine,
invalid credentials, missing files, errors and switch-off cannot return 304.
Prove actual Chrome cache revalidation without interception/cache disabling,
including no stale fallback after refusal, before claiming transfer savings.
Live loading comparisons use three normal navigation rounds, with min/median/
max and bytes. No writer or load test is part of this change.

Reference: [HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching)
and [304](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/304).

## Local evidence

Seven targeted workerd tests pass against real repository authorities: private
304, changed body, revoked/invalid/foreign credentials, path restrictions,
quarantine, switch-off, ordinary/text/missing/non-raster/oversized responses and
the JSON-only regional-hop boundary. The initial hit test failed before the
adapter existed. Conditional headers stop at the outer HTTP adapter; an internal
regional hop must still return JSON, not a bodyless 304.

Actual Chrome over local HTTP with this adapter passes five transport checks:
unchanged image revalidates as 304 with zero body bytes and the browser supplies
its cached JSON; changed content returns 200; fresh refusal returns 403 with no
old content; another cookie receives its own admitted 200; offline fetch fails
without stale content. The admission in this transport fixture is simulated;
the workerd cases above exercise the real authority. Neither is a live latency
or worldwide cache-performance claim. The production frontend must also opt
into the query and preserve these headers during the deployed check.

The final own-checkout Wasm build and seven Worker cases pass. Twelve existing
frontend raster/path checks, dev/prod configuration parity, TypeScript,
frontend production build, touched-source Biome, Rust fmt and xtask Clippy pass.
Independent review found no additional boundary/privacy blocker; the parallel
frontend opt-in remains an explicit integration requirement before rollout.
