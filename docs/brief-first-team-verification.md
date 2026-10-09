# Brief-first team planning verification — 2026-10-09

Build together now starts from the approved brief, current source, selected context and one to six editable agent connections. It no longer adds a third agent or supplies event-search/RSVP tasks. Manual ownership and dependency controls are available through **Advanced task plan**, off by default. The first selected agent plans read-only; a selected worker can also integrate the final result.

## Combined source gate

`cargo xtask doctor` and the final `cargo xtask check` exited **0**. The gate covered Rust formatting, Clippy with warnings denied, **186 native tests**, the optimized workers-rs Wasm build, TypeScript/Biome, **173 workerd tests across 38 files**, **4 Node runtime tests**, and the Vite production build. The deployment's pinned Linux image separately passed **42 runtime tests**. Local tests use no provider keys or paid inference.

One combined read-only integration review identified a scheduling mismatch: dependency-free tasks could run simultaneously on one selected roster agent. A failing native regression reproduced it. The scheduler now reserves that roster slot through trusted source capture, while distinct agents can work in parallel. Terminal failure wakes unrelated ready work; retries wait if the same slot is busy. The console mirrors that waiting state.

Native and real Rust-DO/workerd tests cover exact job/epoch-derived proposal identity, optimistic draft refinement, immutable duplicate proposals without pointer rollback, eight-version bounds and epoch reset, invalid/cyclic plans, unchanged-source completion, rollback, eviction, cancellation, stale retries, shared model accounting and worker/integrator reuse. Planner completion hints cannot dispatch work. Read-only source checks reject file modification, addition, deletion and executable-mode changes. Synthetic planner output and captures in these tests are explicitly distinguished from live inference. The final read-only combined review found no material correctness or security blockers in draft identity, optimistic updates, replay, freezing or completion boundaries.

## Development deployment

`cargo xtask deploy` exited **0**.

| Component | Serving version |
| --- | --- |
| Platform Worker | `199fb404-b1fe-4a73-a0c5-ba3b5ad997b8` |
| Sites Worker | `b4bb97d5-305d-4eae-938a-4668757d35a6` |
| Runtime application | `a03b85b8-fac1-4f41-a046-6abe33ff1531`, version 20 |
| Runtime image | `sha256:820922c861c550340137768efb161b78202020248f13a6134ad3cffa912e80ea` |

Container inspection confirmed the new digest/version, no active rollout, seven healthy instances and no health errors before starting acceptance. Ledger and runtime capability `team_planning: 1` reject older versions before inference. Existing migration 8 and stable DO identities are retained; proposal records use the graph rather than a new schema migration.

## Served console acceptance

Chrome retained the signed-in `mlong168` account. In an existing unpublished repository, selecting Build together kept the existing two-agent roster. Removing an agent reduced it to one; adding another worked without fixed model assignments. Enabling the optional task editor showed a blank task rather than unrelated event/RSVP instructions. Removing the last task left an editable empty draft. Disabling the editor unmounted its required fields; the brief-only form had zero invalid required inputs and no hidden worker fields. The draft was cancelled without starting paid inference or changing repository source.

The pictured bilingual San Jose meetup brief was retained in that draft, including its frontend/API/SQLite requirements. The form visibly states that the current publisher hosts static frontend output; backend services and databases require separate deployment. This verification does not claim to have hosted that full application.

Console screenshots, private acceptance request, deployment readiness and run evidence are kept under ignored `artifacts/brief-team-acceptance/`. Credentials and expiring preview capabilities are excluded from Git and this document.

## Live acceptance scope

A separate acceptance account started `brief-team-3e4c7a0f-405e-405c-9e95-a5e22d6dea16` in repository `repo-6d7f0af5e6b110623653665c95894a3e`. The request contains two saved MiMo/ZAI connections and no `team` plan. Its explicitly static, illustrative San Jose cycling guide asks for complementary trail data/filtering and accessible bilingual interface contributions. It excludes accounts, bookings, storage and backend deployment; it is not a substitute for the owner's API/SQLite application brief.

That first acceptance attempt was cancelled during planning. MiMo submitted a syntactically valid placeholder while probing the tool, and the first-draft lock prevented replacement. No worker tasks, candidates or publication were created. The regression was reproduced locally. Drafts now support optimistic refinement before completion, with immutable version history and no changes to an already frozen execution plan.

The corrected deployment then started `brief-team-a29961af-172f-47cc-a6e7-bede903c520b` in `repo-46d9c3ce7e8c2a00d372937b26bbfbf3`, again with two saved connections and no explicit plan. MiMo reached its ten-minute execution deadline after 26 provider requests returned HTTP 200 headers without storing a valid proposal; no tasks or candidates were created and no transcript was retained for the deadline abort. This does not establish why the model failed to plan. A GLM-first comparison (`brief-team-37501b0f-025d-4624-8d96-441fb631bbb4` in `repo-daa0ef6c59e4ef7f8a35926b82ecf3bd`) was also started before the broker correction, then cancelled with no tasks or candidates. These trials do not establish a model-specific cause.

Inspection found a separate transport defect: an unawaited MCP promise bypassed the broker error handler, losing typed validation feedback on rejection. A failing real-DO regression reproduced this, and awaiting the call returns the expected JSON error. Worker-only hotfix `edc48c2b-3baf-493a-80b1-6f3a47c2cf3b` passed adapter checks and deployed without changing the container image.

The deadline regression also reproduced missing output from a child that emitted MCP validation feedback before stalling. Supervisor-owned bounded memory now survives cancellation, uploads a marked partial transcript before failure, and retains existing attempt fences. The upload is bounded to two seconds; explicit agent budgets reserve ten seconds for process cleanup, evidence and failure acknowledgment. Already acknowledged immutable transcripts are preserved. Four native regressions cover process termination, callback order, stream/escaping bounds, rejected or acknowledged uploads and stalled-upload cutoff.

## Corrected-image console acceptance

The signed-in `mlong168` console created the isolated **Brief-first team acceptance** repository and started `run-05031df3-f89d-49c2-bec0-ac8e89d9e1d2` by approving the static cycling-guide brief above. **Advanced task plan** stayed off. The two selected connections were GLM `glm-5.3-flash` first and MiMo `mimo-v2.6-flash` second. Request and dollar caps stayed unset; each execution had ten minutes and 4,096 output tokens per response. No Claude inference was used.

GLM planned two specific tasks from the brief, completed read-only planning, and implemented the trail data/filtering task. MiMo implemented the bilingual interface and then integrated both captures. The planner chose a dependency from the interface to the data task, so this trial demonstrates complementary collaboration in sequence, not concurrent execution. The earlier explicit-plan acceptance remains separate concurrency evidence.

| Stage | Agent | Captured revision | Changed paths |
| --- | --- | --- | --- |
| Trail data and filtering | GLM | `e45addf03` | 1 |
| Bilingual interface | MiMo | `9dea5ecc2` | 4 |
| Final integration | MiMo | `20172b4bb` | 5 |

The console's trusted integration receipt bound both exact specialist revisions to the final capture, with manifest `d14200912`. The clean evaluator reported **site: pass**, exit 0 with successful setup, and **static_assets: pass** on the final revision. It became eligible and ready for review. No publication decision was recorded.

Browser acceptance used that evaluator-captured preview. A trimmed mixed-case Guadalupe search returned one route; retaining only hard difficulty returned a clear empty state; clearing search returned two hard routes. Spanish changed headings, labels and route content, with document language `es`. Tab reached a difficulty checkbox and Space toggled it, updating the result count. Resetting the controls restored all six routes. A requested 375 × 812 mobile override rendered at 341 CSS pixels in the current browser zoom; document width also measured 341, with no horizontal overflow, and the saved screenshot showed readable stacked controls. The viewport override was reset.

MiMo's interface handoff cited the data agent's handoff and described the actual two-argument filtering API, correcting the planner's shorthand. Final integration also implemented the shorthand and repaired list semantics. These explanations remain assertions; the captured source and browser behavior are separate evidence. The Context usage panel recorded **11 retrieval calls**, **11 distinct opened records**, **6 distinct cited records** and **1 evaluator result**. This establishes recorded delivery, lineage and the tested behavior, not model comprehension or a controlled comparison against plain notes.

The completed run recorded 15 GLM requests and 30 MiMo requests, including planning, work and integration. All attempts finished; no paid monitor or background test loop remains. Console receipts, handoffs, retrieval records and desktop/mobile screenshots are retained in the ignored acceptance directory.

## Limits

Subsequent UI heading correction deployed as platform Worker `09b56303-54ea-4293-8520-ec222f049944`, without a container rollout. Run headings and history labels now use a first-sentence title bounded to 90 characters; the full approved brief and criteria remain in a collapsed, keyboard-accessible disclosure. TypeScript, Biome and the frontend production build passed. Served-console acceptance on the completed run measured an 18-pixel, one-line heading and verified exact preservation of the brief and all four criteria when expanded. Screenshot: ignored `artifacts/run-heading-acceptance/compact-heading.png`.

Safe amendments after task activation, external agents joining hosted team tasks, automatic repair escalation and live six-agent capacity acceptance remain later work. Agent plan and handoff explanations remain assertions. Captures identify actual source and independent checks establish only their tested behavior; this acceptance does not establish graph superiority over plain notes or model comprehension.

See [current team workflow](build-together.md), [the earlier explicit-plan acceptance](team-integration-verification.md) and [the separate context usefulness experiment](plans/context-usefulness-pilot.md).
