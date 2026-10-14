# YonedaRepo — Claude handoff

**Implementation is stopped at the user's request. This document transfers context; it does not authorize resuming work.**

The fresh competition demo is **not ready**. The guided workflow is deployed, but its first hosted rehearsal exposed two blockers. Both have local fixes waiting in the working tree. Neither fix has been deployed.

## Start here

| Item | State at handoff |
|---|---|
| Repository | `/Users/mlong/Documents/Development/yonedarepo` |
| Branch | `codex/yonedarepo-mvp`; no root Git remote |
| Committed HEAD | `3dfa9733fa1fb310f5997b235028d307888eb29b` |
| Live frontend/API | `https://yonedarepo.com` and `https://www.yonedarepo.com` |
| Worker version | `90ca1515-e7bd-4543-af36-b4094ceef6b1` |
| Live runtime image | `registry.cloudflare.com/f011d0ee02b23cad26b4b38151b204ad/yoneda-runtime-guided-r15@sha256:45de2634df8ae51dad23c2577338cebfcfad5e6a9bbb76178f638bb3b75f9160` |
| Last verified rollout | Application version 35, completed; 7 healthy, 0 failed, 0 old instances |
| Readback time | `2026-10-14T13:03:07.329Z`; refresh this evidence before acting |
| Fresh guided acceptance | **Not completed** |
| Paid work during this diagnosis | No new builder/reviewer inference; saved-source capture and evaluation only |
| Parallel agents | All six agents in this Codex session were closed |

Read `AGENTS.md`, this document and `git status --short` before changing anything. Preserve the dirty working tree. Do not reset, discard or indiscriminately commit it.

## Product the user wants

**YonedaRepo — Agent-First Repository.** An API-first, Git-like transactional model where agents fetch only what they need, coordinate changes and preserve context.

This is a working competition demo, not a billing project or a business-moat exercise. Judges will create fresh work rather than inspect our prebuilt results.

The ordinary user flow is:

1. **Start a Run:** describe an app, feature or bug fix. One agent is a sensible starting point; the system plans and coordinates additional approved agents. Users may add agents. Keep controls simple: agent/model/role, with optional reasoning effort.
2. **Work happens:** agents retrieve prior context, communicate, integrate changes, resolve conflicts and attempt bounded repairs.
3. **Review result:** show what changed, why, checks, unresolved issues and the decision needed. Humans review the output, not task-planning machinery.
4. **Continue or publish:** a subsequent run carries relevant context forward; publication is a separate human decision.

The reviewer uses an ordinary account. Its differences are private-key login, managed provider connections and guided sample entry points. Preserve the existing configurable **$50 shared workspace allowance** and accumulated usage. Billing comes later. Do not rotate keys, reset spending, rewrite prior approvals or silently switch to a more expensive model.

The user wants speed: focused verification of changed boundaries, then one integrated hosted rehearsal. Avoid repeatedly running the whole gate for unchanged code.

## What is implemented and committed

Commit `3dfa973` adds a fresh `task-board-v1` guide through normal project/run APIs and the served frontend:

| Stage | Intended evidence |
|---|---|
| Build together | Planner defines a shared API contract; at least two specialists work concurrently; captured contributions form one independently checked result; stable-ID design choice is recorded |
| Continue from context | New run adds task bookmarks, opens the earlier design record through `context_get`, cites it through `context_publish`, and preserves earlier behavior |
| Reconcile concurrent changes | Two runs start atomically from the same checked base; filtering and sorting both edit `visibleTasks`; stale recovery/coordinator resolves actual overlapping changes and obtains fresh combined checks |
| Review and publish | Human inspects one final result and the evidence, then separately approves publication |

Important authority properties:

- Rust stores guide sessions and derives progress from capture, checks, overlap, context-access receipts and registered conflict resolution.
- GET does not start work. Starts use stable request IDs and transactional replay. Two concurrent starts roll back together if either fails.
- Server-frozen phases are `build`, `extend`, `parallel` and `final`. Parallel jobs have the frozen `filter` or `sort` variant; final checks have no variant.
- The runtime injects protected phase/variant environment values after clearing the untrusted child's environment. The ledger rejects mismatched reports.
- Partial guide results cannot publish. Final publication requires the completed chain and exact checked working revision.
- Stale eligible team results wake a coordinator within the original approval, including existing repair and budget limits.
- The CLI uses the server-assigned session ID. A replaced provisional UUID is permitted only before any work/request/evidence has been recorded.
- The continuation prompt does **not** repeat the earlier stable-ID decision. It asks agents to open and cite prior context instead.

Key source areas: `shared/guided-runs.ts`, `commands/guided.rs` and `commands/guided/*`, `cloudflare/worker/guided-*.ts`, `frontend/src/features/guided-demo/*`, `fixtures/guided-task-board/*`, `tools/guided-acceptance.mjs` and `tools/guided/*`.

These implementations/local tests are not proof that the entire hosted guide has succeeded.

## Blocker 1 — guided project lost its marker

The actual served UI created a fresh project in the ordinary `reviewer` workspace:

- ID: `repo-8c52e7e4431c572974dd1175fc567a0e`
- Name: `Guided task board — verification`
- URL: `https://yonedarepo.com/?repo=repo-8c52e7e4431c572974dd1175fc567a0e&guided=task-board-v1`

Observed through ordinary authenticated APIs: project `ready`, policy `task-board-v1`, but **no `guided_project` marker**. Its source was the ordinary starter at `40b7170ec643ec0cab48afadaa8acdb2011c94f5`, not the published guided starter. The UI correctly refused the guide. No model work was started.

The precise live cause of marker loss is not established. An older warm Workspace binary ignoring the private field is a hypothesis, not a proven cause. The Repository snapshot exposed the new `guided_runs:1` capability, but that alone did not establish Workspace support.

**Pending local fix, agent F, frozen:**

- Native `workspace_capabilities` reads `guided_projects:1` without mutation.
- Adapter checks that capability before reserving a guide.
- Immediately after reservation, adapter verifies exact marker/source/policy retention before scheduling provisioning.
- Background alarm/queue provisioning refuses an unmarked guided policy instead of falling back to the ordinary starter.

Uncommitted files:

```text
backend/crates/yoneda-app/src/workspace/mod.rs
backend/crates/yoneda-app/src/workspace/projects.rs
backend/crates/yoneda-app/src/workspace/guided_project_tests.rs
cloudflare/worker/guided-project.ts
cloudflare/worker/projects.ts
tests/workers/guided-provisioning.test.ts
```

Evidence: 15 focused Workerd tests passed in F's final run; parent subsequently ran **8 provisioning tests against rebuilt Wasm**, **4 Native guided-project tests**, and scoped app/worker Clippy successfully. Logs: `/tmp/yoneda-guided-retention-latest-wasm.log`, `/tmp/yoneda-guided-retention-native.log`, `/tmp/yoneda-guided-retention-clippy.log`, `/tmp/yoneda-guided-retention-wasm.log`.

The rebuilt Wasm exists locally; the fix is **not committed or deployed**. After deploying it, verify a genuinely fresh project through the ordinary UI. Do not adopt or relabel the incorrect project as successful guided evidence. A guard passing locally is not completion of this blocker.

## Blocker 2 — lazy-source static export returns ESTALE

Actual saved-source evaluation produced:

```json
{"version":1,"stage":"walk","code":"IO","errno":116,"path":null}
```

Source and `normalize-query` checks passed; `static_assets` failed. The independently fetched report's SHA-256 was verified:

```text
a2018f58df53a79f07ca6b63cc66e207bcee96f00859228cfd1fb8ca4372cd7e
```

**Root cause reproduced locally:** `SourceBackend::list(path)` means directory children, but the native `source_list` endpoint accepts a textual prefix. Sending `public` returns `public` itself and may match siblings. Child validation rejects this, and FUSE maps the error to Linux `ESTALE` (116). Direct known-file reads passed because they did not enumerate the directory.

**Pending runtime fix, agent A, frozen:** send `public/` for a nonempty directory and retain the empty prefix for root. Workspace versions remain pinned across pages. Identity checks, child validation, no-follow/regular-file/size/revision guards remain in place. No full-clone fallback or ignored errors were added.

Uncommitted files:

```text
backend/crates/yoneda-runtime/src/source_client_api.rs
backend/crates/yoneda-runtime/tests/source_fuse.rs
backend/crates/yoneda-runtime/tests/source_http.rs
backend/crates/yoneda-runtime/tests/support/source_directory_http.rs
backend/crates/yoneda-runtime/tests/support/source_http_export.rs
backend/crates/yoneda-runtime/tests/support/source_native_http.rs
```

Evidence: actual root Linux `/dev/fuse` + real Native SQLite authority over loopback HTTP reproduced the exact hosted failure before the fix and passed after it; 12 HTTP tests passed; scoped runtime Clippy/format passed. This is **local** Linux/FUSE evidence, not hosted success.

Read `.local/source-api/a-static-export-estale-handoff.md` for the exact six-file hashes and test recipe. Private hosted proof is `.local/source-api/export-diagnostic-r15/actual-diagnostic.json` and `execution/receipt.json` under that directory.

**A new runtime image is required. No image rebuild was started after this fix.** The currently deployed R15 image still contains the bug.

## Do not reuse the exhausted saved-seal retries

The diagnostic used the second original seal's previously unused capture retry:

- Repository: `repo-a3539621c7688c6daa032a6dbe215624`
- Run: `run-ab957cce-3661-46bf-b970-548b46149703`
- Branch: `work-source-compare-66cc08a7-41a1-4e92-8078-d9f22625e6f9`
- Second recovered revision: `31dca4c32d0b8f9f2c25699db192ea62d6edd348`
- Original model requests stayed **48**; review requests by round stayed **[9, 0, 0]**.

Both original retry allowances are now consumed. Do not reset quotas, modify old approvals, rerun paid builders or manufacture fresh source registrations from old proof.

The private diagnostic runner halted with `CHECK_ONLY_CAPTURE_REQUIRED`: it expected skip reason `CAPTURE_RECOVERY_CHECK_ONLY`, while the server correctly reported `NO_CHECKED_RESULTS` for rejected checks. The fetched report still established the export failure, and authoritative recovery metadata had `automatic_review:false`. No new comparison review was run. The runner's receipt remains `terminal:false`; do not relabel it successful.

For hosted proof after the fix, use a legitimate fresh verification path or explicitly authorized check-only re-evaluation mechanism. Existing retries must not be bypassed. Keep model spending bounded under the existing allowance.

## Immutable starter already published

| Item | Exact value |
|---|---|
| Artifacts starter | `yoneda-guided-task-board-v1-20261014` |
| Root commit | `ca7c0f2e3df6e0278c52aeccf672b442cb1a33ca` |
| Tree | `5652d72bc54603cc1cb94902a6bf732a6952b405` |
| Protected bundle digest | `0ed2d2391ed1d62741fa6184bdafb52b0d9b59c0d0d9fb5167bf279544f28893` |
| R2 key | `sha256/0ed2d2391ed1d62741fa6184bdafb52b0d9b59c0d0d9fb5167bf279544f28893` |

The source is intentionally unfinished. Bootstrap produced one deterministic root commit, verified Git/server readback and canonical R2 bytes, and revoked the temporary Git write capability. It made zero model requests.

Private receipt: `.local/guided-task-board/bootstrap-receipt.json`. Parent setup script: `.local/guided-task-board/parent-bootstrap.mjs`; default is prepared-only, `--seed` mutates. Do not reseed or change the immutable bundle merely to get passing evidence.

Fixed protected check command:

```text
node /opt/yoneda/test-bundle/fixtures/guided-task-board/oracle/run.mjs
```

## Deployment configuration and credentials

Private configuration: `.local/deploy/production/platform.json` (0600). Backup: `platform-before-guided-r15.json` in the same directory.

Current configured selection:

```text
SOURCE_TRANSPORT=api-source-v1
SOURCE_TRANSPORT_REPOS=repo-a3539621c7688c6daa032a6dbe215624
SOURCE_GUIDED_ENABLED=false
GUIDED_TASK_BOARD_STARTER_REPO=yoneda-guided-task-board-v1-20261014
GUIDED_TASK_BOARD_BUNDLE_DIGEST=0ed2d2391ed1d62741fa6184bdafb52b0d9b59c0d0d9fb5167bf279544f28893
```

Unrelated new runs default to Git-native transport. Existing approvals retain their frozen transport. Only enable additional lazy-source guide approvals after verification; do not globally change unrelated users' runs.

Credential locations, **values must never enter output, arguments, browser storage or Git**:

- `.local/owner-token`: existing operator token.
- `.local/reviewer/access.json`: existing reviewer account/access data, 0600.
- `/Users/mlong/Library/Preferences/.wrangler/config/default.toml`: existing Cloudflare OAuth configuration.
- Real provider credentials remain in Worker bindings/sealed workspace connections.

Use existing safe helpers: `tools/guided/credentials.mjs`, `tools/context-study/booking-operator.mjs`, and `tools/acceptance/client.mjs`. Read secrets into RAM only. Do not print raw authenticated responses or Git stderr.

Refresh health and rollout readback before any later deployment/verification. The private R15 activation receipt is stale by design after five minutes; do not edit its timestamp to satisfy a guard.

## Verification already done — avoid rerunning everything

- `cargo xtask doctor`: passed.
- Combined gate's fmt, workspace Clippy, Native workspace tests, actual Wasm build and adapter checks passed. Its platform phase had **586 passing / 2 failing of 588**, both stale MiMo pricing expectations.
- Those MiMo fixtures were fixed: focused RED 2 failures → GREEN **3 passed**. No production pricing changes were made in that fix.
- Remaining gate slices were run separately: **15 app tests**, **43 runtime Node tests**, **311 frontend tests**, production frontend build passed.
- Guided Node tests: **15 passed**; guided platform subset: **26 passed**.
- Independent actual-Wasm adversarial tests: **4 passed**, with review clear for the frozen original authority/orchestration scope.
- Native guided authority: **19 guided + 6 coordinator + 13 conflict tests passed**.
- The later pending fixes have the focused checks documented in their blocker sections.

**Do not claim `cargo xtask check` exited 0:** the monolithic invocation stopped at the stale MiMo assertions. Subsequent focused and remaining slices passed. Important logs are `/tmp/yoneda-guided-final-gate.log`, `-final-apps.log`, `-final-node.log`, `-final-ui.log`, `-final-frontend-build.log`, `-final-cli.log`, `-final-five.log` and `-final-ts.log`.

## Remaining work, if the user authorizes resuming

1. Review and commit only the pending marker and directory-prefix fixes; preserve other changes. Rebuild the runtime image, obtain the **registry manifest digest**, update private configuration, deploy and verify Worker revision plus completed healthy container rollout. The local Docker image ID is not the registry digest.
2. Verify a fresh ordinary-account project retains the marker and forks exact starter `ca7c0f2…`; exclude the incorrect first project. Confirm the lazy-source exporter against a legitimate fresh hosted verification without resetting old retry allowances.
3. Allowlist only that fresh canary, then complete build → context continuation → actual conflict resolution → final checks through the real guide. Record actual overlap, opened/cited context, exact source/check binding and scoped resolution. Clean merges are not proof of conflict resolution; receipts are not proof of causal context benefit.
4. Verify reload does not duplicate work; running actions are disabled; multi-file review and reasons are understandable. Verify partial-stage publication is denied and final review is actionable. Any automated test publication must be labeled developer verification, not human acceptance.
5. Rehearse a second genuinely fresh guide using the normal reviewer path. An unfamiliar human rehearsal is a separate gate and has not been established for this new guide.
6. Hide only quiescent operator-owned/reviewer test fixtures through the ordinary recoverable visibility API. Preserve personal projects, provider connections, spending and history. Judges should encounter a clear fresh entry, not our accumulated experiments.
7. Update existing submission/evidence docs, export current source, get public CI green, and refresh/watch the video against the current UI. The last recorded public export was `48f1cbb…`; it predates this guide and had a stale pricing-test CI failure. Verify current remote state rather than assuming it has stayed unchanged.

The public export clone is `.local/public-source-autonomy-13eccb1`, with origin `https://github.com/MagnetonIO/yonedarepo.git`. Root repository intentionally has no remote. Export through `tools/export-source.py` rather than publishing private local history or `.local` files. Competition application, eligibility and attendance remain human actions; do not automate submission.

## Architecture and truthful positioning

Cloudflare Workers provide the TypeScript SDK/API adapters; Rust owns domain rules, transactional authority and native execution. Durable Objects are Repository Authority, Workspace Authority, LiveRoom, ExecutionContainer and SourceWorkspaceAuthority. Queues dispatch build/capture/evaluate/publish. Artifacts retains Git source, R2 immutable content/evidence/checks, D1 a rebuildable index, and isolated Sites/Apps Workers serve checked output.

The experimental lazy path uses Linux FUSE → scoped source APIs → SourceWorkspaceAuthority/R2 → sealed incremental capture into Artifacts. It is not globally activated and has not completed this hosted acceptance. We retain Git compatibility; do not claim a wholesale Git replacement, Scion-equivalent distributed changeset architecture, unmeasured scale or universal semantic conflict resolution.

## Dirty changes outside the two pending fixes

At handoff there were additional edits in public metadata/branding, `frontend/index.html`, social-card assets, `WorkspaceRail.tsx`, `WorkspaceWelcome.tsx`, onboarding/responsive styles and `website-metadata.test.ts`. Their origin was not established in this session. Preserve them and establish ownership before committing or deploying them. The user's requested title is “YonedaRepo — Agent-First Repository.”

## Local Docker containers and stop state

Source development occurred on the Mac. The two long-lived Rust containers were for local Linux/FUSE tests, with `/source` mounted read-only and persistent Cargo/target cache volumes:

```text
yoneda-c-source-fuse-arm
yoneda-c-source-fuse-mmap
```

The user asked to remove them. `docker rm -f` was attempted, but Docker reported it tried to kill the containers and received no exit event. **Removal is not confirmed; they may remain stuck.** Do not claim success. Do not restart Docker or remove shared volumes without considering impact on the user's other work. No Docker daemon restart was performed. This is a local Docker cleanup issue, not a Cloudflare deployment or paid-agent job.

All six Codex subagents were closed. No new runtime rebuild, deployment, paid run or application-code edit should be continued from this handoff unless the user asks to resume.
