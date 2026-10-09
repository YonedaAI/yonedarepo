# UI workflow and deployment verification

October 8, 2026. This update gives the browser separate Runs, Context graph and Source history views; account, repository, provider and local-agent dialogs; named provider connections; two to four hosted approaches; and a visible shipping review dialog. The [workflow](website-workflow.md) describes the product path. The [README](../README.md#deploy-to-your-own-cloudflare-account) describes deployment to another account.

## Selection and browser behavior

The reported selection problem was reproduced on the served app with the actual Field Notes follow-up and an expanded source diff. The old action added an inline form without moving focus, which made its result easy to miss. The current action opens a native modal, identifies captured revision `0e9551767036469317baaab2338bb15324a0eeae`, and focuses the rationale textarea. The dialog fits inside the observed desktop viewport and its publish button stays disabled without a reason. Closing review leaves the run ready and unpublished; canonical published source remains `8c328b2ede2a337a19bebded3b00f296108b5ffd`.

![Shipping review for the unpublished follow-up](images/selection-review.png)

Browser verification also covered:

- Create account, sign-in and recovery navigation; mode changes clear credential fields. A failed sign-in shows an inline error. No password was changed in these checks.
- Provider configuration with five choices and an additional named connection in local development. Saved secrets are not returned to the browser.
- Adding four approaches in the real composer, then cancelling. An invalid duplicate-strategy brief was rejected before scheduling. Its error previously appeared behind the modal; the fix keeps it visible inside the composer.
- Context graph navigation, a search with no results, restoring the full graph, and tracing `public/index.html` at the published revision. The trace retains the first Field Notes decision's automated development-verification provenance.
- A mobile account screen with no horizontal overflow at the observed 354px effective content viewport, collapsed navigation and stacked fields. Dialog Escape handling and rationale focus were checked against the served app.

Current screenshots are in `docs/images`; local logs and the before screenshot are in ignored `artifacts/ui-workflow`. Screenshots do not establish that a new hosted run completed. No paid inference or owner follow-up publication was started during this update.

## Required local gate

`cargo xtask check` passed **74 native macOS Rust tests, 38 actual workerd tests and one Node runtime test**, along with rustfmt, Clippy with warnings denied, the actual workers-rs Wasm build, TypeScript, Biome and the production browser build. The complete log is `artifacts/ui-workflow/check.log`. Subsequent frontend changes passed their TypeScript/build and Biome gates; the final deployment-tool changes passed Clippy and all six xtask tests.

The execution image built and passed **16 Linux runtime tests**. A real pinned Gemini CLI `0.63.0`, running as UID 1000 with Docker networking disabled, completed an offline provider-fixture interaction through the real Rust MCP server. It called `context_publish` once and exited successfully. The first smoke exposed a headless workspace-trust failure; the harness configuration was corrected before the successful check. The fixture uses no paid inference. Logs: `artifacts/ui-workflow/gemini-smoke.log` and container build logs in the same folder.

Workerd coverage verifies independent same-provider connections, list responses without ciphertext/plaintext, connection-bound encryption, provider mismatch rejection and removal isolation. Gemini tests verify the pinned native model path, output bounds, rejected paid server tools/media references, and refusal to run against an old image missing the Gemini harness. Four-agent scheduling tests verify shared source and independently frozen connections/models.

## Public CI

[Public CI run 37813638281](https://github.com/MagnetonIO/yonedarepo/actions/runs/37813638281) passed for public source revision `6ad3746acbbaf66ecf1e6535d27b4a02a46ce090`. It ran the native/Wasm/workerd/browser gate, built the execution image and verified the real Gemini CLI with the offline provider fixture. This is separate from paid Gemini acceptance.

## Deployment verification

The existing development platform was updated at [yonedarepo-dev.mlong-f01.workers.dev](https://yonedarepo-dev.mlong-f01.workers.dev/). Final platform version: `e636416c-fc58-4448-bd58-a16e24b6af01`. Dialog closure restores focus to the triggering selection button; this was observed after the final deployment. The execution image includes the corrected Gemini trust environment; its SHA-256 is `5bbef45ae017d91ddfd4206bb0d7d147e21d073a53c789a7265641cae416765b`. Later frontend-only deployments retain that image. The sites Worker was unchanged.

Portable account configuration was generated for a distinct placeholder account and namespace. Both Workers passed actual Wrangler dry runs. Repeating configuration preserved file hashes; changing deployment identity under the same name was refused. Fresh local D1 migration and repeated application passed against the generated account-specific config. Named local development uses the same explicit persistence directory for migrations and both development Workers. Logs: `portable-dry-run.log`, `configuration-repeat.log`, `portable-local-migrations.log` and `xtask-final.log`.

These checks prove config generation, bundling, local migration repeatability and failure boundaries. **Deployment into a new Cloudflare account has not been executed.** Billing, product access, target-account resource provisioning and initial container availability still require the documented manual steps. The deploy command preserves existing deployed vault keys, refuses unavailable secret inventory, uploads newly required secrets through a private temporary file, removes that file, and bootstraps/readbacks the Artifacts starter with a deployment-specific operator credential.

## Remaining acceptance boundaries

- Luna and Sonnet live concurrency/publication evidence belongs to the [earlier MVP release](release-evidence.md). This update exercised no new paid hosted run.
- Gemini's native protocol/CLI/MCP path passed offline integration. Paid Gemini completion and deployed model egress with a funded user key remain unverified. MiMo balance and ZAI live-result limits from the release evidence remain unchanged.
- Hosted personal BYOK inference still lacks live acceptance; named connection isolation has workerd coverage.
- The current target is static websites. Full-stack hosting, generic task DAGs, automated semantic merges and clarification that pauses/resumes a run remain future work.
- The [presenter video package](video/production-brief.md) contains prepared narration and editing directions. Artlist and Higgsfield were authenticated for media-tool inspection; no new avatar video is claimed by this workflow verification.

## Six agents, delegation, model budgets and restart

Later on October 8, 2026, the console added two to six root agents, optional bounded subagents,
shared per-model budgets, safe provider failure explanations and **Restart run**. Budget cards
show one optional USD amount; request counts, execution time, response size and pricing are under
collapsed **Advanced limits**. Brief approval approves configured limits and rates together.
Restart preserves historical evidence and creates a fresh run using current repository checks.

One combined integration review found two issues: Gemini retained a fixed 24-turn CLI limit,
and restart could restore older repository checks. Both were corrected with regression coverage.
`cargo xtask check` then passed **109 native Rust tests, 61 workerd tests and one Node runtime
test**, plus formatting, Clippy, Wasm, TypeScript, Biome and the production browser build.
The Linux execution image passed **27 runtime tests**. After the budget presentation was
simplified, the five affected budget/restart helper tests, TypeScript, Biome and browser build
passed again. Logs are in ignored `artifacts/scalability`.

The actual locally served app exercised a two-root shared model allowance, usage reservation and
settlement without upstream inference: **2 / 3 requests** and **$0.002725 / $2**. Cancellation and
restart created a new linked run at **0 / 3** and **$0 / $2**, while the original retained its usage.
The simplified restart dialog preserved its hidden limits and accepted an optional dollar amount
without extra opt-in or pricing approval checkboxes. Local six-root and two-level delegation
checks are explicitly fixtures, not evidence of six overlapping paid model executions.

The development Worker is deployed as version `dc781201-cff5-4fbc-b942-e326dda73c83`.
Cloudflare reports execution-container application version **10** as **ready**, with registry
image SHA-256 `f75b9774e898e2e2eed2ab88cf4fd1795de1b7958e7ef6613ca56740fab21ec1`.
The final browser-only deployment used `--containers-rollout none` to preserve that image.
The deployed restart dialog was checked in a separate browser tab without changing the owner's
existing draft. Its MiMo/ZAI cards showed only optional dollar amounts with Advanced limits
collapsed. Reading the original run's outcomes showed MiMo's insufficient account balance and
ZAI's legacy execution-budget stop as distinct diagnoses, without exposing raw transcript text.
The container ceiling is 16 instances; this does not establish 16 concurrent executions.
No paid retry, new six-agent live run or new publication was started for these checks.

## Provider model selection and recorded failure diagnosis

The console now offers provider-specific model dropdowns for MiMo, ZAI, OpenAI/Codex,
Anthropic/Claude and Google/Gemini. Custom IDs and previously saved custom models remain
available where provider policy permits them; Claude remains Sonnet-only. Defaults are
unchanged. Published catalogs supply the presets, not a live entitlement check of a user's key.
ZAI's connector explains its Anthropic-compatible endpoint and links account model support.

Inspection of the latest failed personal run established two distinct outcomes. MiMo reached
its approved **24-request** allowance after approximately seven minutes. The CLI replaced the
Worker's JSON error envelope with its message, which the original diagnostic parser missed.
Native and browser diagnostics now recognize only the complete allowlisted terminal budget
messages, with regression coverage for altered text, wrong status and nonterminal output.
ZAI returned **HTTP 429, business code 1302**, before successful model output; its CLI retries
used **11 request slots**. The owner confirmed the dashboard key was saved in that connection;
personal runs resolve the frozen connection and do not fall back to platform secrets. The
response does not establish insufficient account balance or explain the dashboard's
"Not used" indicator. Provider account/model access still needs successful live acceptance.
The usage panel now states that requests include retries and provider rejections.

One combined source review and `cargo xtask check` passed **110 native Rust tests, 68 workerd
tests and one Node runtime test**, with rustfmt, Clippy, Wasm, TypeScript, Biome and production
browser build. The Linux execution image passed **28 runtime tests** and built successfully.
Logs are in ignored `artifacts/scalability/check-provider-fix.log` and
`container-provider-fix.log`.

Development Worker version `049dc3e9-679b-442e-81d3-e0be956c410b` is active. In a separate live
browser tab, all five provider lists preserved their defaults, custom entry worked, and
**Explain failure** on the existing MiMo execution identified its request allowance and
directed the owner to **Restart run**. Screenshots are in ignored
`artifacts/scalability/provider-model-picker-live.png` and `provider-failure-fixed-live.png`.
No key was saved, no run was restarted and no paid inference was initiated for these checks.

Wrangler published runner image SHA-256
`2bb47dadd4f3dfd5c4419c546061502b89e4938f10d102056acb0ed2c198442f`. After its rollout,
Cloudflare reported application version **11** as **ready**, and a separate application read
confirmed that image digest. This is image deployment evidence; no new paid agent execution
was started to exercise it.

## Provider registry, subscription routing and optional request limits

Later on October 8, the public provider registry became the shared source for Rust validation
and scheduling, Worker endpoint/authentication configuration, and browser model presets. The
[provider guide](providers.md#adding-a-provider) describes adding compatible providers and the
separate adapter work required for a new protocol. New ZAI connections now default to
**GLM 5.3 Flash**, with GLM 5.3 also offered for Coding Plan accounts. Existing connections keep
their recorded model IDs.

MiMo settings distinguish **API credits** from **Token Plan subscription**, with an explicit
China, Singapore or Amsterdam region. Dedicated Token Plan keys cannot be saved against the
API-credits route. Routes come from the saved owner connection, are frozen for roots and
subagents, and reject changes after approval. Tests cover encrypted storage, fixed upstreams,
key-type rejection, browser route tampering and inherited subagent routing. There is no
automatic regional fallback. ZAI remains a Coding Plan connector; general API bundles are a
different product and route.

New hosted runs have optional request and dollar caps, both blank by default. Execution time,
response size and the existing Claude workspace ceiling remain bounded. A regression test
allows 150 reservations in a new uncapped run while historical runs retain their recorded
limits. New ledger/runner capability checks reject incompatible old binaries before inference.
No SQL schema change was required; additive JSON metadata and rollback ordering are documented
in the provider guide.

`cargo xtask doctor` and the combined `cargo xtask check` passed: **112 native Rust tests,
71 workerd tests and one Node runtime test**, plus formatting, Clippy, Wasm, TypeScript and the
production browser build. The final targeted routing/budget/restart check passed **13 tests**;
the final Biome check reported no issues. The Linux runner image passed **28 runtime tests**.
Logs are in ignored `artifacts/scalability/check-token-plan.log`, `token-plan-targeted.log`
and `deploy-token-plan.log`.

Explicitly authorized tiny coding probes with the supplied credentials returned **HTTP 200**
for MiMo's Singapore Token Plan endpoint (`mimo-v2.6-flash`, 20 input/10 output tokens) and
ZAI's Coding Plan endpoint (`glm-5.3-flash`, 23 input/13 output tokens). The MiMo key was rejected
by the China endpoint. Credentials were entered through hidden terminal input, not command
arguments, logs or repository files, and were not saved into the personal workspace. These
non-streaming probes establish authentication and small-response inference only; tool calling,
streaming and a complete paid agent build were not exercised.

The development Worker is deployed as version `8910f38e-4b52-4ec2-bf9b-4a8645f5f2d6`.
The runner image has registry SHA-256
`41ec07b5d4e10c32b8f9551608448a115688cfcdeb34e5010cd34f7442b85916`.
Cloudflare reports container application version **12** as **ready**; a separate application
read confirmed that image digest. The configuration-only final Worker deployment preserved it.
Live browser checks confirmed the ZAI default, MiMo plan/region picker, and a new-run composer
with an empty request field and **No request cap** placeholder. Screenshots are in ignored
`artifacts/scalability/zai-default-live.png`, `token-plan-picker-live.png` and
`optional-caps-live.png`. No saved connection was altered, run restarted or website published
during browser acceptance.

## Approach presets

Each root agent now has an **Approach** dropdown with eight presets and a **Custom approach**
option. The selected preset supplies the actual instructions recorded in the approved brief,
not just a display label. Switching to custom retains those instructions for editing. Adding
an agent chooses an unused preset, and presets assigned to other agents are disabled.

TypeScript, Biome (**97 files**, no issues) and the production browser build passed. The live
development Worker, version `c65b291c-32f7-4bae-b688-fc02b4a46ed7`, was checked for preset
selection, custom editing, six agents with distinct defaults, and restoring a historical
custom approach through the restart dialog. The screenshot is in ignored
`artifacts/scalability/approach-picker-live.png`; logs are `check-approaches-final.log`,
`build-approaches.log` and `deploy-approaches.log`. This browser-only deployment preserved
the ready runner image above. All browser drafts were cancelled without starting inference.
## 2026-10-08: MiMo recovery, retained logs and decision copy

The historical Chicago run's MiMo transcript reported a local HTTP 409: its Token Plan key was configured for API credits. No inference request completed. Connection editing now preserves the encrypted key, applies optimistic version checks, and validates the key against billing source and region. Starting a run also checks legacy connections before creating execution work.

The deployed console successfully saved the existing MiMo connection with Token Plan / Singapore and an empty replacement-key field. An incompatible API credits selection was rejected with actionable guidance. Existing run approvals remain frozen.

Worker version `317dd142-c588-4dbe-b336-716d894332a9` includes the new log viewer and decision wording. The deployed Wasm digest was compared with the local build and matched. An older Workspace DO briefly returned an unknown-operation error during propagation; the subsequent existing-connection save succeeded. No DO identity or stored data was replaced.

Both completed Field Notes approaches expose **View logs**. The live viewer loaded and refreshed an empty historical timeline with the correct Coding Plan label. These runs predate request logging, so this does not establish a populated production inference timeline. Cloudflare tail separately captured a structured `request.rejected` record with `PROVIDER_CONFIGURATION` and HTTP 409; only allowlisted application fields were retained in the local evidence export.

The deployed Linux container image was exercised locally with an explicitly invalid offline job. It emitted correlated JSON `attempt.started`, `attempt.failed` and `attempt.callback_failed` records; neither a private payload marker nor the fixture supervisor token appeared in them. The fixture used no inference and its temporary container was stopped.

The shipping dialog now asks **Why wasn’t “[approach]” selected?**, with **Explain why it wasn’t selected or when it might be useful.** as the placeholder. Browser acceptance opened the dialog and verified the deployed wording without recording a decision or publishing a candidate.

Validation: `cargo xtask doctor` and `cargo xtask check` passed, including Rust formatting/Clippy, 116 native Rust tests, the actual workers-rs Wasm build, TypeScript/Biome, 75 workerd tests, one Node runtime test and the browser production build. The Linux image build also passed 29 runtime tests. Local evidence is under ignored `artifacts/scalability/`: `check-logging-final.log`, `native-json-logging-fixture.json`, `cloudflare-safe-logs.json`, `decision-wording.png`, `mimo-connection-saved.png` and `execution-logs-empty-history.png`.

## 2026-10-08: Execution timeout diagnosis and longer approved runs

Run `run-2109d499-041b-434b-b96d-d6bb6956ce73` in **test again** stopped its MiMo execution at YonedaRepo's approved ten-minute deadline. The retained timeline records 18 model requests with HTTP 200 responses; the authoritative terminal error is `Execution deadline exceeded`. The Token Plan / Singapore connection authenticated successfully. This failure does not establish a provider balance or credential problem. The completed GLM candidate at `24f5f6864` remains eligible.

Timeouts now have the explicit `EXECUTION_TIMEOUT` classification. The console recognizes the exact historical error too, explains the time limit, and directs the owner to **Restart run** instead of provider settings. **Minutes per execution** is visible in the main model settings and accepts 1–30 minutes; the default remains 10. Queue admission, container startup and approved execution time have distinct deadlines. Ledger/runtime capability checks reject longer approvals during incompatible rollouts. A valid execution lease renews container activity so background work can use its approved time.

Worker version `251e6310-7650-4fd1-a228-5626dc3736f9` is deployed. Container application version 14 has no active rollout or reported error and uses image digest `e7829d621cfc34849a872ef241dfaf4783085b63be401c3aded3f00d66f4f030`. An offline Linux health check reports protocol 2 and `max_execution_ms: 1800000`; networking was disabled and no inference job was submitted.

The live browser shows **MiMo reached the execution time limit** on the failed run. Its restart form accepts 20 minutes and advertises a maximum of 30. The draft was cancelled: no paid rerun, shipping decision or publication was initiated. Screenshots are `artifacts/scalability/mimo-timeout-diagnosis.png` and `mimo-restart-time-settings.png`.

Validation: the pre-fix regression reproduced two failures; the final `cargo xtask check` passed Rust formatting/Clippy, 117 native Rust tests, the actual workers-rs Wasm build, TypeScript/Biome, 77 workerd tests, one Node runtime test and the browser production build. The Linux container build passed 29 runtime tests. Evidence is in ignored `artifacts/scalability/timeout-regression-before.log`, `timeout-check-final.log`, `deploy-timeout-fix.log` and `container-timeout-info.json`. A real 30-minute paid run has not been performed.

## 2026-10-08: Repository deletion and editable run rosters

The repository header now has **Repository options (⋯) → Delete repository**, with exact-name confirmation. Rust commits a permanent tombstone, cancels/fences active jobs and removes outstanding dispatches before asynchronous cleanup. Workspace grants, discovery, container stops and owned Artifacts remotes are cleaned through durable outbox entries. Periodic sweeps reclaim asynchronous imports/forks after originating requests end; unique cleanup generations fence stale acknowledgments. Independent cleanup continues when a container stop fails. Deleted repositories reject context/source access, new work, late callbacks and previous preview capabilities. Internal audit/ledger and content-addressed R2 evidence are retained; this is product deletion, not complete byte erasure.

Run membership is now editable from one to six initial agents. **Add agent** and visible **Remove agent** controls operate on the current draft; the last agent cannot be removed. Older ledgers keep their advertised minimum and reject unsupported single-agent API requests before provider validation. The configured connections are choices, not a fixed provider pair. A published site offers **Update website**, suggests one agent and shows the current canonical starting revision. Completed published runs are identified as history; no publication automatically launches another run. Single-agent changes retain capture, independent evaluation and owner selection/publication, without requiring an alternative comparison.

The combined `cargo xtask check` passed: Rust formatting/Clippy, **123 native Rust tests**, the actual workers-rs Wasm build, TypeScript/Biome (**109 files**), **88 workerd integration tests**, one Node runtime test and the production browser build. The last browser copy adjustment also passed Biome and a fresh production build. Native/workerd regressions cover deletion ownership, confirmation, active fencing, pending publication, idempotency, eviction, late remote creation, stale cleanup acknowledgment, failed stops, preview revocation and older-code propagation. A two-agent release followed by a one-agent update verifies canonical base selection and retained history using explicitly synthetic capture/evaluator/publication observations; it is not paid inference or real Git verification.

Development Worker version **`b899ba4c-5ade-4b38-afff-66268d641787`** and sites Worker **`51877f5b-6d0c-4f5b-a17b-9e245426f229`** are deployed. The existing container image `e7829d621cfc34849a872ef241dfaf4783085b63be401c3aded3f00d66f4f030` was preserved; Wrangler reported no container application change. Existing Repo DOs initially returned `Unknown repository operation`; the adapter now reports `LEDGER_UPDATING` with retry guidance for that exact older-code response. A bounded deferred promotion still exposed older behavior; the tested version was then promoted with immediate DO code update mode. Subsequent live behavior confirmed adoption without resetting any DO identity or data.

Live browser acceptance created only **Disposable deletion acceptance**, repository `repo-1a99a9aa4c6714e897d84bde9a3781b2`, from the starter without launching agents. Wrong-name confirmation was disabled; exact-name confirmation was enabled; Cancel preserved the repository. After the user's explicit approval, deletion succeeded, selected an existing repository and stayed absent after a full reload. D1 retained its monotonic `deleted` tombstone at sequence 2. A separate Artifacts read returned **Repository not found, code 10200**, establishing managed Git cleanup for this idle fixture. No existing user repository was deleted.

On the existing published Field Notes website, the live **Update website** draft showed canonical revision `8c328b2ed` and one agent. Adding another enabled both removal controls; removing the first retained the second connection (MiMo) and updated model settings to that remaining model. The draft was cancelled. The published historical run shows **Recorded execution history**, its verified publication and the update action. Existing runs, shipping decisions, provider connections and websites were not changed by acceptance; no paid inference was started. Active container shutdown and already-issued production preview revocation were verified in local regressions, not exercised against an active user's run.

Evidence under ignored `artifacts/scalability/`: `deletion-and-run-roster-check.log`, `run-roster-browser-build.log`, `deploy-deletion-and-run-roster.log`, `deploy-repository-deletion-sites.log`, `activate-deletion-and-run-roster-immediate.log`, `repository-deleted-live.png`, `repository-deletion-discovery-after.json`, `repository-deletion-artifacts-readback.log`, `single-agent-update-live.png`, `editable-run-agents-live.png` and `published-run-history-live.png`.

Repository layout cleanup is queued separately as [REPO-001](plans/repository-layout-cleanup.md). No directories were moved as part of these behavior fixes.

## 2026-10-08: Published update continuity

Following the repository layout cleanup (`0f390c4`), updates now resolve the exact decision
matching canonical `published_commit`, instead of resetting to the first preset or copying
the latest failed/unpublished run. **Update website** / **Update project** restores the winning
agent's approach, connection and model, criteria and configured model limits, with fresh usage.
A selected subagent becomes one new root; rejected competitors are not automatically restarted.
Current repository verification policy remains authoritative. Missing or changed connections
require an explicit replacement choice.

The editable context selection carries available published-decision, intent, candidate,
evaluation, execution, artifact and winning-lineage assertion records, bounded to 50. A new
`continuation_of` field is validated by Rust against a verified decision at the current published
commit, then frozen into the run with a decision → run **continues** edge. Pending publication,
stale/missing/non-published decisions and mixed restart/continuation requests cannot schedule
work. Older ledger binaries are fenced by the `published_continuation` capability. There are no
SQL schema or DO class migrations, and the existing native prompt/MCP artifact reader consumes
the frozen context without a runner image change.

Validation: the initial composer regression reproduced the wrong preset/connection. The combined
`cargo xtask check` passed Rust formatting/Clippy, **134 native Rust tests**, the actual workers-rs
Wasm build, TypeScript/Biome, **100 workerd tests**, one Node runtime test and the production
browser build. A final browser extraction/lazy-load change passed affected TypeScript/Biome,
production build and **15 composer/restart tests**. The browser entry chunk is 472.88 kB and
has no chunk-size warning. An expanded **12-test** continuation/composer check also verified
reading a prior published artifact from real workerd R2 through its digest-verifying adapter
after DO eviction, while refusing an artifact outside the new execution's frozen allowlist.
Capture, evaluation and publication observations in integration fixtures are explicitly
synthetic; none of these tests uses paid inference.

Development Worker **`957899d3-a455-42b9-8ebe-6f6d571f9e9d`** is deployed with immediate DO code
update mode and `--containers-rollout none`. Container builds/updates and sites deployment were
not part of this change. Live Chrome acceptance opened **one more time → Update website**:
the published base was **`38a249e8f`**, its original SF cycling brief was shown, **GLM / ZAI /
glm-5.3-flash** and **Rich interactions** were selected, and eight context records were carried
forward. The recorded rationale **Easier to use** and original criteria plus a preservation
criterion appeared. Adding/removing a second draft agent preserved the winner and its context.
The draft was cancelled; no run, provider key, shipping decision or publication was changed.

Ignored evidence: `artifacts/published-continuation/check-final.log`,
`frontend-check-final.log`, `browser-build-final.log`, `composer-check-final.log`,
`artifact-continuation-final.log`, `deploy.log` and `update-published-base-live.png`.

## 2026-10-09: Account identity and recoverable repository onboarding

The header now shows the authenticated personal username and account menu, with a separate
Administrator identity for operator access. Anonymous visitors can open **Sign in** directly.
Repository discovery obtains identity from the authenticated server principal, including empty
workspaces; a revoked account session cannot return its former identity.

Setup now reserves an ID, returns promptly and runs through the existing agent queue without
starting inference or a container. Workspace DO stages, epochs, two-minute claims and durable
dispatch intent prevent overlapping imports and recover lost queue sends, pending operations
and abandoned claims. An alarm continues recovery with the browser closed and stops when idle.
Attempts have a 90-second watchdog; the overall pending deadline is ten minutes. Failed setup
can retry without replacing its project identity. Browser requests have a 20-second timeout
and stale responses are fenced; uncertain mutations are not automatically repeated. The setup
view shows stages, elapsed time, classified errors and retry/status actions.

A read-only investigation found an existing public import whose Artifacts metadata named
`main`, while its source advertised `master`; only the latter had a commit. This formerly
returned an endless pending state. New imports explicitly use advertised HEAD, and earlier
imports recover the actual branch before initialization. This repository was not attributed
to Givi: the user's clarification said he had only signed up. D1 contains a discovery table,
not an account directory; the exact affected signup remains unidentified. Empty repositories
and unsupported source now have explicit failure guidance.

The combined `cargo xtask check` passed Rust formatting/Clippy, **138 native Rust tests**, the
actual workers-rs Wasm build, TypeScript/Biome (**120 files**), **115 workerd tests**, one Node
runtime test and the production browser build. The entry chunk is 479.48 kB with no chunk-size
warning. The combined review's two material findings—stranded queue dispatch and unbounded
browser requests—were fixed and rechecked. SQL and Cloudflare class migration histories were
not changed.

Development Worker **`6a7ed5b0-715d-45a9-8c9c-558e3e3fdc4a`** is deployed with immediate DO
code update mode and `--containers-rollout none`. Existing containers, sites, secret bindings
and resource identities were preserved.

Live HTTP acceptance on the real Cloudflare deployment verified a fresh signup, empty personal
workspace identity, login/logout and logout revocation. A new starter became ready on `main`
at **`40b7170ec643ec0cab48afadaa8acdb2011c94f5`**; a separate public import became ready on
`master` at **`b0a1ea487c6d7028e491e7558a7a0cfd2243d2ec`**. Their creation responses were HTTP
202 in 0.622 and 0.334 seconds respectively, followed by queue-driven stages and owner-scoped
snapshot readback. Repeated creation requests returned the same ready IDs. Only these two
QA repositories were deleted, and the QA workspace was empty after signing in again. No
existing user repository or source was changed and no paid model request ran. The isolated QA
account remains available locally with its credentials in an ignored, permission-restricted file.

The served browser assets contain the account identity and setup/timeout changes. Visual browser
acceptance was unavailable: the computer-use service returned no connected browser or native
surface. HTTP acceptance and bundle checks do not establish rendered layout or keyboard
acceptance; no screenshot success is claimed.

Ignored evidence: `artifacts/account-identity/integration-check.log`,
`provisioning-deploy.log`, `live-acceptance.json` and `deployed-bundle.json`.
The source-based architecture is documented separately in
[current-state architecture](current-state-architecture.md); `architecture.md` remains unchanged.

## 2026-10-09: Username or email accounts

Signup, sign-in and recovery now accept usernames or practical ASCII email identifiers. The
browser's username-only pattern was removed. Rust owns canonical validation; browser/Worker
validation uses the same contract cases. Surrounding whitespace and letter case normalize to
one identity, while dots and plus tags remain distinct. Existing username workspaces, cookies
and MCP keys keep their identifiers and formats. An email is not an automatic alias for an
existing username account, and no email ownership verification or recovery mail is claimed.

Session cookies and MCP key segments encode email punctuation, keeping their dot separators
unambiguous. Both queue consumption and Workspace alarm dispatch accept canonical email owners.
Invalid identifiers, reserved operator identities and malformed/ambiguous encoded segments
remain rejected. Recovery revokes old sessions and MCP keys.

The regression reproduced **three failures** before the fix. The combined `cargo xtask check`
passed Rust formatting/Clippy, **140 native Rust tests**, the actual Wasm build,
TypeScript/Biome (**121 files**), **120 workerd tests**, one Node runtime test and the production
browser build. The final form helper copy also passed formatting and a fresh TypeScript/build.
Combined review found no material blocker. No SQL or DO class migration was needed.

Development Worker **`6ed1a165-01c4-4c4d-a4da-4cf9e64f345b`** is deployed with immediate DO code
update mode and no container rollout. Live HTTP acceptance used an isolated `example.test`
account: mixed-case/whitespace signup, authenticated email identity, queued starter setup,
owner-scoped snapshot, a read-only MCP key, recovery invalidation, login with the new password
and logout all passed. Project creation returned HTTP 202 in **0.472 seconds**, then reached
ready on `main`. Only its QA repository was deleted. Existing users, credentials and projects
were unchanged; no paid inference ran. QA credentials remain in an ignored private local file.

Ignored evidence: `artifacts/account-identity/email-regression-before.log`, `email-check.log`,
`email-browser-build.log`, `email-deploy.log` and `email-live.json`. Visual browser acceptance
remains separately unverified because browser control is unavailable.
