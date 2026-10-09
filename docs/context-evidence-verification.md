# Context evidence verification — 2026-10-09

Context delivery receipts, local MCP session attribution, the agent-facing `context_usage` tool and its per-run console projection are implemented and deployed to the development environment. Public sharing metadata and favicon assets are deployed. Collaborative team execution remains a separate [implementation plan](collaborative-agent-runs-plan.md).

## Local integration checks

| Check | Result |
| --- | --- |
| `cargo xtask doctor` | Pinned tools and Docker available |
| `cargo xtask check` | Passed, exit 0 |
| Native Rust tests | 156 passed: app 103, core 11, runtime 27, xtask 15 |
| Workers runtime integration | 149 tests across 34 files passed under workerd |
| Rust formatting and Clippy | Passed; warnings denied |
| Actual workers-rs Wasm build | Optimized build passed |
| TypeScript, Biome, frontend production build | Passed |
| `node --test tests/runtime/*.test.mjs` | Four Node runtime/stdio-relay checks passed |
| Linux runtime tests during image build | 30 passed |
| `cargo xtask context-study verify-controls` | Seven synthetic controls behaved as expected; no inference |
| `git diff --check` | Passed |

Controls cover a broken baseline, correct reference, allowed anonymous event storage, forbidden attendee identity storage, a combined search/privacy/capacity regression, forged verdict and forged observations. Each uses an immutable mount. The behavioral oracle is a finite fixture check; it is not a general privacy proof or browser acceptance test.

Local logs are ignored artifacts: `.local/context-integration-final-check.log`, `.local/context-runtime-final-check.log` and `.local/context-study-recheck.log`. Ordinary integration checks require no provider credentials or paid inference.

## Development deployment and browser acceptance

`cargo xtask deploy` completed successfully after the combined integration gate. The final platform Worker version is `b50fd46c-5491-4df4-83c7-78fff222781f`; the published-sites Worker version is `139ef9ee-16a1-4e0d-b58b-e6efc0d2a7a1`.

Development URL: <https://yonedarepo-dev.mlong-f01.workers.dev>. This records a development deployment, not production release or owner acceptance of agent-generated products. Deployment output is retained in `.local/context-evidence-deploy-final.log`.

The real served console was inspected in Chrome using the existing signed-in workspace. The context panel loaded for a historical run, showed unavailable prior read activity as unknown rather than zero, displayed citation/capture/check lineage, kept run-wide counts when filtering retrieval entries, and rejected an invalid attempt epoch without issuing a request. Loading and successful refresh states were observed. A screenshot is retained at `artifacts/context-evidence/console.jpg`; it is an ignored local acceptance artifact.

After the final deployment, unsigned HTTP checks verified that initial HTML contains absolute Open Graph/Twitter/canonical URLs with no template placeholders. `/favicon.svg`, `/favicon.ico`, `/apple-touch-icon.png` and `/brand/social-card.png` returned HTTP 200 with appropriate image MIME types. No private repository or account content appears in sharing assets.

New tracked jobs require runtime `context_usage: 1`; study jobs also require `context_study: 1`. Workerd regressions verify rejection of incompatible images before inference. This prevents mixed-version deployments from silently invalidating delivery tracking or study isolation.

## Paid smoke pilot: incomplete, no graph advantage established

The pilot prepared three dedicated synthetic repositories through scoped MCP contributions, trusted source capture, independent platform evaluation and automated fixture publication. It then started six real hosted executions using the saved MiMo/ZAI connections: two per condition. Explicit allowances were 60 requests per model group, 4,096 output tokens per response and ten minutes per execution. All three fixture contribution grants were revoked after collection.

| Condition | Completed executions | Exact captured revisions checked | Behavioral passes |
| --- | --- | --- | --- |
| Source only | 1 / 2 | 1 | 0 / 1 |
| Plain notes | 2 / 2 | 2 | 2 / 2 |
| Graph | 0 / 2 | 0 | Unobserved |

Three executions reported `RUNTIME: Harness exited 143`. Provider logs include successful HTTP 200 responses; the root cause remains unresolved. These are not established account-balance failures, and the missing outputs are not counted as checked failures. The graph condition retrieved mechanical run/source information but no historical corpus records before stopping.

The initial oracle incorrectly rejected all storage writes, although the corpus prohibits only storing attendee names/email. Inspection showed both plain-notes candidates persisted anonymous event flags. The corrected `context-fixture-v2` oracle checks supplied identity canaries, permits anonymous flags, and has positive/negative controls for that distinction. All three immutable captured revisions were rechecked without inference. The source-only candidate still failed the historical search and privacy contracts; both plain-notes candidates passed.

Original results remain in `artifacts/context-study-smoke`; corrected results are in `artifacts/context-study-smoke-rechecked`, including each prior verdict in `oracle_previous`. The full 27-cluster/45-execution study, delegated case and fresh local continuation have **not** been run. This smoke wave does not establish a causal or general graph benefit.

## Remaining acceptance work

1. Trace and resolve the exit-143 failures using container lifecycle and harness evidence, then obtain complete matched post-rollout trials.
2. Run the remaining hosted/delegated/local cases under the [controlled pilot plan](plans/context-usefulness-pilot.md). Fresh local inference requires operator-supplied private credentials; vault keys are not exported.
3. Inspect a complete chain containing historical corpus retrieval, explicit citation, captured source and the relevant behavioral check before presenting a usefulness claim.
4. Implement the separate team-run plan: complementary specialists, typed handoffs and one integrated candidate, followed by a combined review/check and owner publication decision.
