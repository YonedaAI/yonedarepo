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
