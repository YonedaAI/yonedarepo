# Run results: interaction and evidence review

Reviewed against the served console on 2026-10-09, including the checked, unpublished San Jose team run.

## Findings

| Priority | Observed problem | Effect | Change |
| --- | --- | --- | --- |
| High | Publication review follows the entire context ledger, budget report and team task list. | The required decision is several screens away. | Keep next action above all evidence tabs. |
| High | Eligible, selected and published are spread across different sections. | A checked preview can be mistaken for a shipped release. | State the pending decision and publication state explicitly. |
| High | An older ready run is hidden behind the latest run in a history dropdown. | Outstanding review can be missed. | Surface other reviewable runs in an attention queue. |
| Medium | Restart and cancel sit beside the title while review is a quiet full-width button at the bottom. | Secondary operations receive more emphasis than the next step. | One emphasized review action; lifecycle controls in Run details. |
| Medium | Logs, commit metadata, checks, preview and diff occupy separate vertical blocks. | A single integrated result looks larger than its useful content. | Compact result header and action row; disclose detailed evidence. |
| Medium | Disabled selection has no visible explanation. | The operator cannot distinguish stale source, changed policy or pending publication. | Show the specific selection blocker. |
| Medium | Technical metadata competes with the result. | Scanning requires knowing implementation vocabulary. | Results, Agent activity, Context usage and Run details have separate tabs. |
| Medium | Moving evidence into tabs can break links to hidden task/approach targets. | Handoff inspection or failure recovery becomes a dead end. | Tab-aware navigation reveals and focuses the target. |
| High | An open page lost an unloaded evidence asset after a deployment and became blank. | Recorded work appears lost and the workspace cannot recover through its UI. | Bound evidence loading errors; preserve the decision area and offer Reload workspace. |

## Design

Preserve the existing IBM Plex Sans/Mono typography and restrained developer-console palette: ink `#152436`, muted `#637286`, background `#f6f8fb`, surface `#ffffff`, action blue `#245de8`, confirmed green `#157f72`. Use amber for blocked work. Color supplements a written status and icon.

Left-aligned compact headings identify the run; the decision area is the only strongly accented surface. Borders distinguish controls and evidence boundaries. No decorative animation or oversized metrics.

```text
Development runs                                      New run
Other runs awaiting review (only when present)
Run history
Compact run title / base revision / team size
NEXT ACTION: Review required                       Review result
Checked revision; publication has not started      Preview website
Results | Agent activity | Context usage | Run details
Selected evidence panel
```

## Functional rules

| State | Top-level direction | Available next step |
| --- | --- | --- |
| Current eligible result | Review required; distinguish checked from published | Open existing decision form; preview exact checked revision |
| Some agents failed, useful result available | Review useful result; mention failed attempts | Review result or inspect agent activity |
| Planning/building/capture/checks | Agents working or checks pending | Inspect activity; no publish action before eligibility |
| Failure with other work active | Attention needed; remaining work continues | Inspect failure and existing retry controls |
| Failed checks or exhausted attempts | No publishable result | Inspect results or activity; restart remains in Run details |
| Stale base/policy or another publication pending | Review blocked with the specific reason | Inspect evidence; preserve backend guards |
| Decision recorded, publication pending | Publication in progress | Inspect recorded decision; no duplicate selection |
| Publication failed | Publication failed; decision remains recorded | Inspect failure and existing repository recovery controls |
| Published | Published revision is explicit | Open hosted site only when it matches this decision |
| Cancelled | Cancelled; history retained | Inspect evidence or restart from Run details |
| Empty run list | Clear invitation to start | New run or connect local agent |

The console remains a projection. Rust continues to enforce selection, source leases, policy and publication. A request to review opens a form; it never publishes automatically. Context access and agent citations remain separate from independent behavior checks.

## Acceptance

Check the real console: pending review above the tabs; compact result layout; all tabs reachable with keyboard arrows, Home/End and Tab; source/check disclosures and preview still work; task links reveal their activity target; decision form opens and cancels without publishing; changing runs resets evidence navigation; mobile has no horizontal page overflow. Verify selection and attention ordering with state fixtures covering stale source/policy, publication pending/failure, partial failures, retries and old pending reviews.

## Verified implementation

Deployed the Worker and browser assets to the existing development console, version `9c23889f-2620-4612-8850-c2a865db27d3`, with `--containers-rollout none`. The runtime image and agent work were not redeployed. No new paid agent runs or shipping decisions were created during this review.

- `cargo xtask doctor`, `pnpm check`, and the production browser build passed. Browser results are loaded as a separate module; the main bundle is 467.25 kB without the previous chunk-size warning.
- 40 focused tests across four workerd test files passed. The new attention cases cover current integration retries, absent/obsolete policy, stale HEAD, repository readiness, another publication, cancellation, recorded publication outcomes, partial agent failure, and old pending reviews.
- In the real checked team run, the main review action moved from 4,294 px below the viewport origin to 404 px, inside the 722 px desktop viewport. Results, Agent activity, Context usage, and Run details are separate accessible tabs.
- The top review action opened the correct decision form for `20172b4bb`; closing it preserved the unpublished run. The original complete brief and all four acceptance criteria were preserved exactly.
- Arrow keys and Home/End changed the selected tab; Tab entered the active evidence panel. Included-task navigation revealed Agent activity and focused the matching task. Source/check disclosures, the execution log dialog, and the checked-preview link worked. Run history now uses action-oriented statuses such as review required and published.
- Context usage still returned 11 opened records, 6 explicitly cited records and one independent revision check. Delivery remains distinct from asserted use and verified behavior.
- The existing published comparison run displayed published revision `5563aa6db`, had no repeat publish buttons, and opened/focused its recorded decision. Its captured-source comparison remained available. An empty repository retained New run and Connect local agent actions.
- A temporary browser network block simulated an unavailable context evidence module. The panel showed Reload workspace while the review action stayed visible. Reload recovered the console. The network block and viewport override were cleared afterward.
- Mobile testing produced a 354 px CSS viewport and a 354 px page width: no horizontal page overflow; the review action remained visible. Evidence tabs scroll within their own strip.

Screenshots are local verification artifacts under `artifacts/run-results-acceptance/`: `review-first-results.png`, `mobile.png`, and `evidence-error.png`.

One existing navigation limitation remains: a full page reload selects the first repository rather than restoring the selected repository/run. Recorded work remains intact; preserving selection in the URL is a follow-up improvement. Publication failure and multi-run attention ordering were checked with state fixtures rather than new paid live executions.
