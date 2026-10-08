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
