# Hosted team integration verification — 2026-10-09

This document records the earlier explicit-plan release. The later brief-first workflow and its separate evidence are in [brief-first verification](brief-first-team-verification.md).

The explicit-plan **Build together** MVP is implemented and deployed to development. Two real provider-backed specialists worked concurrently on separate modules; a third agent retrieved their captured handoffs, integrated their exact source, and produced one independently checked revision. Automated development publication completed with canonical Git readback. This is a disposable acceptance project, not a human product selection or competition submission.

## Combined integration gate

`cargo xtask doctor` and the final `cargo xtask check` both exited **0**. The combined gate covered Rust formatting, Clippy with warnings denied, **171 native tests**, the optimized workers-rs Wasm build, TypeScript, Biome, **162 workerd tests across 36 files**, **4 Node runtime tests**, and the Vite production build. The main browser chunk is 492.80 kB; team workflow and context evidence views load separately. The deployment's Linux image build passed **36 native runtime tests**.

One read-only review examined the combined frontend, ledger, adapter and runtime changes. Two unused API entries were removed before the final gate. Tests cover plan/DAG/scope validation, scheduling, immutable handoffs, retry fencing, cancellation with parallel work, manifests, acceptance, binary/deletion/executable-bit assembly, migration creation/reapplication/upgrade, source authorization and context lineage. Workerd tests exercise the real Rust DO; their source captures are explicitly synthetic and external Artifacts SDK responses are mocked. Paid execution is separate evidence below.

## Deployment

| Component | Serving version |
| --- | --- |
| Platform Worker | `d8fd5bb2-0151-408a-995f-0a9351ec2cc7` |
| Sites Worker | `dc232906-e92c-4ffb-b1a3-b2b7285e5efc` |
| Runtime application | `a03b85b8-fac1-4f41-a046-6abe33ff1531`, version 17 |
| Runtime image | `sha256:79baea159e63e393b8a658476020f202856d8771db6e7cfe4afa001a570d8524` |

`cargo xtask deploy` exited 0. Container inspection confirmed version 17 serving with no active rollout or health errors before the successful paid attempts. An initial attempt started while version 16 was rolling out; the collaborative protocol guard rejected it before inference. Owner retries resumed the failed tasks after readiness. This verifies compatibility guarding and bounded retry, not a provider balance failure. See [rollout instructions](runbook.md#team-runs-and-container-rollout).

## Real complementary work

Project: `repo-d4f5289a07fbb0d30ed4fbae141534aa` — **Build together — Northside Run Club**. Run: `team-cbc076be-d81d-413f-bab9-213ea8540fd5`. Frozen base: `40b7170ec643ec0cab48afadaa8acdb2011c94f5`.

| Task | Configured provider/model | Exclusive contribution | Captured commit |
| --- | --- | --- | --- |
| Event data and search | MiMo / `mimo-v2.6-flash` | `public/search.mjs` | `a4bbeef3095ff834b8b352c7f127207a50f5a5c1` |
| Anonymous RSVP and capacity | ZAI / `glm-5.3-flash` | `public/rsvp.mjs` | `ca4a98d32e6e23f96c8ca1cccdc9512baeb2a324` |
| Website integration | ZAI / `glm-5.3-flash` | `public/index.html` | `913665d225c233639bd9a626eb6e192e99bf7a06` |

Specialists used task revision 2, execution epoch 4 after compatibility retries. Both were active before the first completed: recorded reads at 20:32:07 UTC for RSVP and 20:32:34 for search preceded agent completion at 20:33:08 and 20:35:26. Source captures finished at 20:33:22 and 20:35:41. The integrator was scheduled only with the second capture. Specialists did not build competing whole websites.

The frozen manifest contains both capture jobs, epochs, task revisions, repositories, commits, trees and owned paths. Digest: `70e11fb48fda529187c5f2df9a3f44eefb93c1871aa1e4c63764448d02a009bb`. Owner source inspection confirmed both specialist files, including executable metadata, were preserved exactly in final source. Only one selectable candidate and one independent evaluation were produced.

Saved provider connections used a 10-minute limit per execution and 4,096 output tokens per response. Request and estimated-dollar caps were unset. No Claude inference was used. No successful attempt in this run exited with signal 15/exit 143; this does not establish the cause or repair of earlier unrelated interruptions.

## Inspectable context evidence

The integrator's successful `team_context` call at **20:36:00 UTC** delivered both platform-captured handoff IDs and the exact manifest under its active job/epoch identity. Its typed finding and final handoff explicitly cited both handoffs. The projection connects specialist findings and handoff assertions to intermediate capture, source inclusion in the final revision and its exact independent checks.

At completion, `context_usage` reported **7 read calls, 8 distinct opened records, 6 distinct cited records and 1 checked revision**. Empty search results stayed empty; returned-record count was zero. No separate `integration_request` call was recorded: `team_context` supplied the manifest, and runtime/capture bound its digest independently. Missing calls are not inferred.

Receipts, citations, exact source comparison and checks establish a concrete cross-agent handoff and integrated behavior. They do not establish graph superiority over plain notes, general model comprehension or six-agent scalability. The controlled usefulness study remains separate.

## Checks, browser observations and publication

The isolated evaluator checked final commit `913665d225c233639bd9a626eb6e192e99bf7a06` under policy `team-demo-v1`, suite `commands-v1`, environment `linux-node24-rust1.94-v1`. **site**, **team_behavior** and **static_assets** passed. The oracle imported captured modules and checked case-insensitive neighborhood search, no matches, past-event exclusion, immutable anonymous counts, first RSVP and capacity rejection. Evaluation evidence digest: `839c2195aaee72fcd10d292ab5b1c4685e2364c3a4cbe38f28f993a28e09f46f`.

The real served console's mode selector, editable roster, plan and integrator assignment were checked in Chrome. Removing an added fourth agent cleared its integrator assignment instead of silently moving it. That draft was cancelled without inference. The paid run used an owner API session in a separate acceptance account; the browser's signed-in account was preserved. Complete team progress UI was covered by workerd view tests, not claimed as an authenticated browser observation of that separate account.

In the isolated preview, uppercase `ANDERSONVILLE` narrowed four events to one, an unmatched query displayed the empty state, and Enter on Lincoln Square RSVP changed remaining spots from 40 to 39. Two generated-site limitations were found:

- Static-site CSP intentionally uses an opaque sandbox origin. Storage is unavailable. Reload restores 40 spots, contradicting the agent's persistence claim. The Node oracle did not test persistence.
- The generated page rerenders after adding RSVP confirmation, immediately removing that message. The count changes, but confirmation does not survive rendering.

Owner observation `finding:team-browser-storage-20261009` records these limits and **challenges** integrator finding `context:d89aaf38-7ae5-4dc2-826e-f56b8aa4a9d7`. It remains an owner assertion supported by browser observations, not an evaluator-issued claim. Later agents can retrieve it; later retrieval or repair has not yet been demonstrated. Static isolation was retained. Follow-up should use honest session-only language or an explicitly designed storage service, and preserve confirmation/focus after render.

Publication used `decision_kind: development_verification` with no invented human choice. Its job completed at **20:41:24 UTC**. Git readback returned the final commit, no pending publication, and the site pointer for that commit. The [published development acceptance site](https://yonedarepo-sites-dev.mlong-f01.workers.dev/p/repo-d4f5289a07fbb0d30ed4fbae141534aa/) opened in Chrome.

Ignored local evidence is in `artifacts/team-acceptance/`: approved request, task captures, integrated source/manifest, evaluator results, events, context usage, publication readback, browser findings and screenshots. Private credentials and expiring preview URLs are excluded from version control and this document.

## Remaining scope

The [current workflow](build-together.md) requires an explicit owner-configured plan. Autonomous planning, safe plan amendments, automated repair/conflict escalation, external/local agents joining hosted teams, six-agent live capacity acceptance, generated-app storage and comparative context usefulness remain outside this verified slice. They are described separately in [the broader plan](collaborative-agent-runs-plan.md).
