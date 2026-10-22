# Runbook

## Dated baseline — October 10, 2026

`cargo xtask check` passed on source revision `a581aaf` (`a581aaf82a8253943c90b5cfd2d71382f6b7ea22`): 284 Rust tests (186 app, 16 core, 66 runtime, 1 Cloudflare and 15 xtask), 290 Workers tests across 59 files, 67 frontend tests across 15 files, and 11 Node tests. The deployed production Worker is version `b4ffc0b4-e801-4271-b119-1d32db58ecd3`, running `a581aaf`. The rolled-out Linux runtime-25 image has seven healthy instances, zero starting, zero failed and no errors; it passed 72 Linux tests at `sha256:04f2029c3d331e7d33bf5f41d9cdc7ee80e4d497905ae79bcb1d92f3251c2f87`, and passed the offline Gemini/Rust MCP smoke test.

Paid run `reviewer-a4ec7f83-c0c5-486e-8760-62a677edcbd4` used runtime 24 (`sha256:4b5439bb9e9504b3ee0466bf73edfa77ae02addea599707e1b3a7615f2f197b6`), passed five checks, and retains seven provenance receipts. Its history is summary/stat-only; it did not store the full patch. The ledger conservatively estimated $2.371496 in charges from 31 Codex and 12 Claude requests; this is not a provider invoice. No additional paid run is planned. Candidate `f5527348509497e87c5942e9fb4fd5094df02d8a` is eligible and its earlier integrated candidate is stale; owner selection/publication remain pending.

The code stores bounded full Git-native capture patches (`7d8ccd5`) and the review UI honestly separates historical summary from **View captured source** through the existing candidate-source API. Candidate identity guards protect the view. **Select all** supports up to 500 files/8 MiB, with inline preview capped at 256 KiB per selected file. The `f5527348509497e87c5942e9fb4fd5094df02d8a` source view was verified against the owner API and current files.

The repaired preview was checked in the browser: English “Clear search” and Spanish “Borrar búsqueda” both work, with the keyboard check changing results from zero to four.

The submission source is packaged as a public export. Verify its originating implementation revision in [`PUBLIC_SOURCE.md`](https://github.com/MagnetonIO/yonedarepo/blob/main/PUBLIC_SOURCE.md) and the corresponding result in [GitHub Actions](https://github.com/MagnetonIO/yonedarepo/actions). Workflow `38088529282` for earlier source `e884a546` is a dated baseline; final-export CI acceptance is reported separately after publication.

The refreshed video is a six-minute (360-second), 12-chapter edit with 48 captions, rendered and uploaded. Normal-speed playback of the prior render reached the end; all 12 scenes and 48 captions were reviewed, and revised chapter 6 was reviewed with the honest history summary, exact captured-source view, and four captions. The final re-render passed ffmpeg decode. This edited video is not a continuous recording of a current full run.

Human reviewer rehearsal remains pending after the final handoff; the key sheet is prepared. The separate [no-paid hosted fixture](platform-acceptance.json) is bounded evidence for refunded capacity deferrals, publication acknowledgment-loss recovery and disjoint refresh, not broad capacity or semantic merge quality.

## History, archives and Git conflicts

Every run works in a lazy source workspace (`api-source-v1`); agents never clone or push.
Deployments require the `SOURCES` binding and `v3` SQLite class migration, the matching
runtime image and all four health markers: `source_api`, `lazy_source`, `source_capture`
and `child_privilege_drop`. The last marker requires an observed UID/GID 1000 process with
zero capability masks and `NoNewPrivs=1`. Without them, starts fail with `LEDGER_UPDATING`
or `RUNTIME_UPDATING` before inference. Never rewrite an existing run's transport or funding.

Source indexing progresses through bounded queue messages before launching models. Signed
metadata journals and completed index manifests bind the verified Git root, immutable
chunks and complete counts. Cache proofs must authenticate their exact object identity;
unsigned older caches require verified reconstruction. Do not grant authority to a cached
flag or an agent-supplied source pointer. First activation may assemble 625 metadata chunks
for each of up to 20 frozen inputs, so the platform sets `limits.subrequests=50000` explicitly.
This is a bounded configuration allowance, not a throughput measurement. See
[Cloudflare's subrequest limits](https://developers.cloudflare.com/workers/platform/limits/).

Source and changed-path pages use opaque filename cursors and pinned digests. A missing
page or provenance record is unavailable evidence, not an empty change or a clean merge.
API resolver scopes exceeding the current 64-scope binding limit are rejected before an
execution is created. Root refresh can retain larger path manifests through private pages.

An exhausted source capture with an already registered immutable seal can use the owner-only
`retry_capture` command after inspecting `job_status.source_registration`. Supply a stable
`request_id`, the original `capture_job_id`, `expected_producer_epoch`,
`expected_registration_id`, the current working branch `expected_commit`/`expected_version`
and `expected_policy_digest`. The command only supports the original fixed Compare builders,
requires idle jobs and unchanged source/policy/intent, and permits one recovery per seal.
Recover builders sequentially: wait for capture and evaluation to finish before the next
request. Replaying the exact request returns its receipt; changed requests are rejected.
This does not start builders or renew inference allowances. Automatic review is disabled
for this recovery, even after successful checks; the human chooses a checked result.

The repository history interface separates compact metadata from run detail. `runs_page` returns `items`, `next_cursor` and a numeric `watermark`; continuation must preserve the opaque cursor and watermark so inserts during browsing do not cause gaps or duplicates. Pages sort newest `created_at` first, then run ID descending, with a default page size of 50 and a maximum of 200. `run_detail` is requested for one run and hydrates its executions, candidates, evaluations, decisions, team records, artifacts and lineage on demand. Metadata pages do not carry source diffs or graph nodes. These operations are deployed; keep clients on the paged contract and verify the requested repository scope when diagnosing an origin-specific failure.

Terminal runs older than 30 days are eligible for archive only after the immutable archive object is uploaded and read back with its digest verified. Commit/compaction must follow that acknowledgment; replay after a lost acknowledgment must be idempotent, and a digest mismatch must leave hot records intact. Archived detail is read through the verified bundle and overlaid with current authoritative repository state. The ledger retains summaries, receipts, provenance and the archive index. Outbox payload cleanup applies only after seven days and preserves replay guards. Unknown or globally shared content-addressed objects are retained. Archive behavior is implemented and deployed, but the current isolated acceptance record does not establish a live archive/replay cycle; verify that separately before making operational retention claims.

The active-work limit is six live runs: queued/running jobs and running external executions count even when a run has already reached a review-ready status. A ready run with no live work does not consume a slot. Completed lifetime history does not consume active capacity. Isolated production acceptance exercised real container-capacity deferrals with attempt refunds. Candidate refresh and conflict resolution run only on lazy-source runs and use frozen manifests and trusted Git readback; preserve both revisions and the decision/history records when a conflict occurs. The accepted fixture produced a clean, freshly checked disjoint two-parent refresh and retained both files; this does not claim semantic conflict resolution quality or broad-scale capacity.

## Team runs and container rollout

[Build together](build-together.md) starts from a brief and one to six selected agents.
The first selected agent plans read-only; the ledger validates and freezes complementary work.
Use **Advanced task plan** only to specify your own contract, dependencies and write paths.
A selected worker can also perform later integration. Capture unlocks
dependent tasks; only the integrated result receives the combined independent checks and shipping
decision. Failed tasks offer bounded retry when downstream inputs have not started.

Wrangler returning a successful Worker deployment does **not** establish that the new container
image is serving. Before a paid acceptance run, inspect the application with the relevant config:

```sh
pnpm exec wrangler containers list --json --config cloudflare/wrangler.jsonc
pnpm exec wrangler containers info APPLICATION_ID --config cloudflare/wrangler.jsonc
```

For a portable deployment use `.local/deploy/NAME/platform.json`. Wait until the image is the
newly uploaded digest, the active rollout is absent and the application reports healthy instances
without startup errors. Record the digest and version with acceptance evidence. New collaborative
jobs require runtime capability `collaborative_runs: 1`; automatic planning also requires
`team_planning: 1` on the ledger and runtime. Older versions stop before inference.
If work was attempted during rollout, inspect its error and retry the failed team tasks after the
rollout finishes. Container stop observations are available in Cloudflare Workers Logs.

For personal signup, provider setup and website publishing, see [the website workflow](website-workflow.md). External agents use [repository-scoped MCP keys](remote-mcp.md). The [retry fixture walkthrough](demo.md) is an operator verification example.

For request failures, open the approach's **View logs**. For platform diagnostics, search the Worker's **Cloudflare Observability** logs by execution/job ID. Rust emits JSON using `tracing`; retained per-agent history lives in Repo DO SQLite. See [logging and retention](logging.md). Existing MiMo connections can be corrected through **Agent providers → Edit connection** without replacing their encrypted keys.

Repository deletion is available under the selected repository's **Repository options (⋯)** menu. The Rust ledger records a permanent tombstone and cancels active jobs before asynchronous cleanup. The Repo DO alarm retries stop and discovery entries independently, so a failed container stop cannot block access revocation. The owner's delete request also revokes the project's agent token on its platform repository with the owner's own session; the platform repository itself stays with its owner (`repository.token_revocation_deferred` means revoke the `yoneda-agents` token there). Cleanup entries recorded before the platform cutover still drain their Artifacts deletions. `repository.deleted` and `repository.cleanup_deferred` are safe operational log events. Do not remove the tombstone or reset the DO identity: old queue messages and in-flight provisioning must stay fenced. Deletion preserves shared provider connections, internal audit records and content-addressed R2 evidence. See [the user workflow and retention boundary](website-workflow.md#delete-a-repository).

## Local prerequisites

Use Rust from `rust-toolchain.toml`, Node 24, pnpm 11, Docker and `worker-build` 0.8.7. `cargo xtask doctor` checks installed commands and Docker availability. `cargo xtask setup` installs locked JS dependencies and creates an ignored owner token with private file permissions.

`cargo xtask check` is the required local gate: Rust formatting, Clippy with warnings denied, native tests, the actual Wasm build, TypeScript/Biome, workerd integration tests and browser production build. It requires no provider keys, Cloudflare login or inference. The test Worker deliberately withholds execution dispatch so real SQLite/R2 behavior can be tested without launching models.

`cargo xtask dev` builds assets and Wasm, applies D1 migrations locally and starts Wrangler. For hot reload, run `pnpm --dir frontend dev` beside it. Full agent execution needs Artifacts access and provider bindings; local unit/integration tests establish behavior without claiming a live agent run. Cloudflare product capabilities that require remote services must pass the live gate separately.

Local private Worker variables live beside the platform config in `cloudflare/.dev.vars`. Setup copies an existing root `.dev.vars` only when the destination is absent and keeps private permissions; it never prints or rotates credentials. Default local state remains `.wrangler/state`. Named environments use `.local/deploy/<name>/.dev.vars` and their existing `state/` directory. Keep these ignored files when updating the checkout.

Root `pnpm dev`, `pnpm build` and `pnpm deploy` delegate to `xtask`. For raw Wrangler commands, always pass the intended config: `--config cloudflare/wrangler.jsonc`, `--config cloudflare/wrangler.sites.jsonc`, or a named generated config. See [portable account deployment](../README.md#deploy-to-your-own-cloudflare-account). Repeating `cloudflare-configure` with the original identity upgrades known source paths in older generated configs and preserves custom settings and resources.

## Development account

`cloudflare/wrangler.jsonc` contains this project's development account, Secrets Store IDs and resource names. Those identifiers are configuration, not secret values. For another account, authenticate using `pnpm exec wrangler login`, update the account and store IDs, provision an R2 bucket, D1 database and queues, then update their identifiers before deployment. Do not reuse production resources for tests.

The provisioned resources are `yonedarepo-dev-objects`, `yonedarepo-dev-index`, `yoneda-dev-{agent,capture,evaluate,platform}` and `yoneda-dev-dead-letter`. D1 discovery uses `cloudflare/migrations/`; repository DO schema uses `backend/crates/yoneda-app/src/migrations/`.

Secrets Store names are `Codex`, `Claude`, `MiMo` and `ZAI`, with Workers service scope. Bindings are `OPENAI_KEY`, `ANTHROPIC_KEY`, `MIMO_KEY` and `ZAI_KEY`. Personal accounts use their encrypted BYOK vault instead. See [vault and budget operation](providers.md). Never fetch these values into the shell, browser or model environment. Regular Worker secret `OWNER_TOKEN` protects the owner API in development. `cargo xtask deploy` sets it from the private local token file, applies D1 migrations and deploys the built Worker/container.

Cloudflare activates Worker code before a container image rollout completes. After an image change, inspect the application's rollout in the Cloudflare dashboard and wait for completion before starting paid demos or installing a policy that needs the new evaluator. `pnpm exec wrangler containers list --config cloudflare/wrangler.jsonc --json` and `pnpm exec wrangler containers info APPLICATION_ID --config cloudflare/wrangler.jsonc --json` show application version/image and health; a successful deploy command alone proves only that rollout started. For a browser/Worker-only update that does not need a new image, use `pnpm exec wrangler deploy --config cloudflare/wrangler.jsonc --containers-rollout=none`. Keep protocol changes compatible through the mixed-version window. See [Cloudflare rollout behavior](https://developers.cloudflare.com/containers/configuration/rollouts/).

Worker and Durable Object code also propagate separately. Before starting paid exploration, the Worker checks the repository snapshot's artifact-read capability; `LEDGER_UPDATING` means retry after propagation, with no new run created. A successful Worker upload does not prove that an existing Repo DO has adopted its code. Cloudflare documents the [temporary code-version mismatch](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).

For a deliberate development cutover after active runs have stopped, `pnpm exec wrangler versions deploy VERSION_ID@100% --config cloudflare/wrangler.jsonc --durable-objects-code-update-mode immediate --yes` promotes the existing tested version with an explicit DO update mode. Confirm the repository capability afterward; promotion success is not the readiness signal. The [Wrangler command reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions-deploy) documents immediate and bounded deferred modes.

For Cloudflare Access, protect the host with an Access policy and configure `ACCESS_TEAM_DOMAIN` (host only) and `ACCESS_AUD`. The Worker verifies JWT issuer, signature and audience. An unverified `cf-access-jwt-assertion` is never sufficient. The browser can then use the Access session and Live DO WebSocket; owner connections use an expiring, signed HttpOnly session cookie. Both support Live DO WebSockets and periodic authoritative snapshot resync.

## Environments, deploys and infrastructure as code

Each environment is one spec in `infra/envs/` (`dev.json` = dev.yonedarepo.com, `prod.json` = today's production) plus a lock of resource identities. The wrangler configs in `cloudflare/` are generated from the spec: change the spec, then `cargo xtask infra gen --env dev` (`--check` compares only; the golden tests in `cargo test -p xtask` fail on drift).

- `cargo xtask deploy --env dev|prod [--dry-run] [--confirm] [--allow-active]` builds Wasm and the frontend, applies D1 migrations, deploys each Worker in cutover order with `BUILD_REVISION` = HEAD, uploads only missing secrets from the spec's secrets file and stops on the first `/health` mismatch. dev deploys only the tip of `dev`; prod only the tip of `main`, with `--confirm`, every dev Worker already at that commit, passing real-world kit evidence for it and no busy container instance (rollouts kill runs). `deploy` without `--env` refuses; `--env prod-legacy --confirm` is the old single-Worker deploy behind the same guards.
- `cargo xtask deploy --env dev --agent-smoke` (off by default) then runs `node tools/staging-realworld.mjs --agent-smoke`: one managed GLM `glm-5.3-flash` agent (`--smoke-provider mimo` for MiMo) in a single-agent run on a fresh kit project must reach a checked candidate for "add `add(a, b)` to src/math.js plus a test" within 6 minutes. It prints wall time, model requests and spend (target under $0.01), the run error, execution log tail and activity events on failure, deletes the project and ends with `AGENT SMOKE: PASS|FAIL`. Evidence goes to `.local/staging/agent-smoke-*.json`, never `realworld*` (the prod guard's evidence).
- `cargo xtask status|rollback --env X` shows live revisions and routes, or rolls every Worker back one deployment.
- `cargo xtask infra plan --env X` compares live Cloudflare state with the spec (create / unchanged / drift / extra / unverified) using a read-only API token (`CLOUDFLARE_API_TOKEN` or `--token-file`). `infra up` creates missing D1/R2/queues, records their ids, regenerates the configs and deploys; `infra down --confirm [--purge]` tears down dev or an `ephemeral-<id>` stack and is refused for prod; `infra smoke` checks the frontend, revisions and owner APIs.
- CI (`.github/workflows/ci.yml`) runs the `cargo xtask check` parts as parallel jobs (the workerd suite in four `--shard` jobs) and, on pushes to `dev`, deploys dev and runs the smoke. The dev deploy uses `--prebuilt <dir>`: it installs the Wasm, frontend and runtime image those jobs built and tested (each artifact carries a `REVISION` that must equal HEAD, else it refuses before any remote change), pushes the image once to the account registry as `<prefix>-runtime:<image id>` (`wrangler containers push`) and deploys container Workers from a copy of their config whose `image` is that registry reference, so wrangler rebuilds nothing. Without `--prebuilt`, prod and ephemeral deploys build everything as before. The push also tags the same manifest `<image tag>--inputs-<hash>`: the hash of the runtime's inputs at that commit (`xtask/src/deploy_inputs.rs`: Dockerfile, entrypoint, `.dockerignore`, root `Cargo.toml`, pnpm manifests, the crates `yoneda-runtime` builds from and their share of `Cargo.lock`). The deploy job first runs `cargo xtask live-check --env dev` and skips the rest, with a job-summary line, when both Workers' `/health` already shows the commit.
- Dev fixes deploy from the owner's Mac: `cargo xtask deploy --env dev [--dry-run] [--allow-active]` (no `--prebuilt`). It reads `CLOUDFLARE_API_TOKEN`, or else `~/.config/yonedarepo/deploy-dev.env` (mode 0600; never printed), builds Wasm and the frontend locally, and reuses the image the container apps run when its `--inputs-` record matches HEAD's inputs (no image build, no rollout). Otherwise it builds the image with `docker buildx --platform linux/amd64` (slow on arm64: the Rust build is emulated), pushes and records it, and stops before the rollout while any container instance is busy unless `--allow-active`. Then migrations, deploys, `/health` checks and the smoke, with a timing table. `cargo xtask runtime-image record --env dev --built-from <commit>` records the inputs of an image pushed before records existed (take the commit from the CI run that pushed it). Kit, deploy-prod and the nightly ephemeral stack are dispatch/schedule workflows, which GitHub runs only from the default branch (`main`).

CI deploy tokens live in the GitHub Environments `dev` and `production` (one token each, never shared): account Workers Scripts Write, D1 Write, Workers R2 Storage Write, Queues Write, **Secrets Store Write** (deploying a Worker with `secrets_store_secrets` bindings fails with code 10021 on Read alone), Artifacts Write, Workers Containers Write, Account Settings Read; zone Workers Routes Write, Zone Read, DNS Write. `infra plan` needs only the Read variants plus Workers Containers Read.

Production cutover notes (not applied to `prod.json` until the owner promotes):
- Give the production CI token (`yonedarepo-ci-prod`) Secrets Store Write before the first `deploy --env prod`.
- Pin ExecutionContainer and CheckContainer with `constraints.regions: ["ENAM"]` and give the agents Worker `placement: {mode: "targeted", region: "aws:us-east-1"}`, as dev has: unpinned dev agent containers ran in HKG/TXL with about 1 s round trips to the Durable Objects, against about 330 ms elsewhere.
- Set `check_instances` (CheckContainer max_instances = checks consumer max_concurrency).

## Sandbox runs (`sandbox-cli-v1`, staging)

A single-agent run started with `"runtime": "sandbox-cli-v1"` in its `start_run` body runs unmodified Claude Code (`claude -p --output-format stream-json`) in a Cloudflare Sandbox instead of the harness container, following Cloudflare's [coding agent runner](https://developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner/). One `AgentSandbox` Durable Object per attempt starts `cloudflare/sandbox/Dockerfile` (kept outside `cloudflare/containers`, so it never counts as a runtime-image input) with Internet access off, `git clone yoneda::<platform>/<repo>` onto a real disk, runs the CLI in the background, streams its events into the activity log every 10 s ("View logs", "Last activity", "idle N min" after 10 silent minutes, never a kill), then squashes the work into one commit on the frozen base and `git push`es it to `attempts/<run>/<n>`. That commit is the run's candidate; the existing evaluator checks it and the owner publishes it as before. The only stop is a two-hour safety cap, which still commits and pushes what exists. Compare and team runs are refused (`NOT_SUPPORTED`); deployments without the `AGENT_SANDBOX` binding refuse the runtime (`SANDBOX_UNAVAILABLE`).

No credential enters the sandbox. Its traffic goes through `SandboxOutbound`, which allows only the run's model endpoint (adding the saved connection's key; managed GLM and MiMo keys stay in the Secrets Store) and this project's platform repository (adding the project's agent token: reads, object and commit upload, and branch moves under `attempts/<run>/` only; never land, review, checks or tokens).

One-time setup on the dev account, with a token that has **AI Gateway Edit** (the model requests go through the gateway named by `SANDBOX_AI_GATEWAY`, `<account>/yonedarepo-staging`, for its logs and analytics; the provider key is still added by the Worker, so the gateway stores no key and needs no authentication):

```sh
A=https://api.cloudflare.com/client/v4/accounts/f011d0ee02b23cad26b4b38151b204ad/ai-gateway
H=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json')
curl "${H[@]}" -X POST "$A/gateways" -d '{"id":"yonedarepo-staging","collect_logs":true,"cache_ttl":0,"cache_invalidate_on_update":false,"rate_limiting_interval":0,"rate_limiting_limit":0,"rate_limiting_technique":"fixed"}'
curl "${H[@]}" -X POST "$A/custom-providers" -d '{"name":"Z.ai","slug":"zai","base_url":"https://api.z.ai","enable":true}'
curl "${H[@]}" -X POST "$A/custom-providers" -d '{"name":"MiMo","slug":"mimo","base_url":"https://api.xiaomimimo.com","enable":true}'
```

The CLI then calls `https://gateway.ai.cloudflare.com/v1/<account>/yonedarepo-staging/custom-zai/api/anthropic` ([custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/), provider-specific endpoint). MiMo Token Plan connections (regional hosts) bypass the gateway and call their region directly. Without the gateway, remove `SANDBOX_AI_GATEWAY` from `infra/envs/dev.json`: requests then go straight to the provider. Gateway dynamic routing accepts only the OpenAI chat format, so there is no GLM→MiMo fallback for Claude Code, and spend limits price only models AI Gateway knows; the smoke reports cost from the CLI's own token counts at the registry's conservative rates.

Deploy: `cargo xtask deploy --env dev` builds the sandbox image from its Dockerfile (wrangler `images.agent`; the runtime-image swap leaves it alone) and adds the `AgentSandbox` class (migration `v2`). Then `node tools/staging-realworld.mjs --sandbox-smoke [--smoke-provider zai|mimo]`: the agent smoke's brief on this runtime must record the pushed commit within 5 minutes; it prints the same timing table plus sandbox milestones and tokens, and fails if the checks reject the commit. Evidence: `.local/staging/sandbox-smoke-*.json`.

## Legacy retry fixture workflow

Create the retry fixture as an ordinary console project from `fixtures/retry-client` (its source lives in the project's platform repository, created in your own request); there is no separate seed command or Git push. Pass its id to `demo`, `verify-live` and `upgrade-policy` with `--repo ID`.

`cargo xtask demo --url URL` starts real inference. Defaults are `gpt-5.6-luna` and `claude-sonnet-5-5` in Wrangler variables. Legacy fixture executions retain 24 model requests per execution across retries, 256 KiB per request and 4096 output tokens per request; legacy Anthropic CLI runs also retain a $1 estimate. New console runs use their approved per-model budgets. Do not silently upgrade a model. Containers are capped at sixteen instances, agents at their owner-approved 1–30 minute execution limit (10 by default), evaluators at two minutes, and infrastructure attempts at two.

Open the browser and connect with the workspace owner token from `.local/owner-token` (paste it or choose the token file), or use the configured Cloudflare Access login. Provider keys are different credentials and stay in Secrets Store. Describe the change in Exploration: research agents inspect the repository and publish guidance and assumptions, then three coding agents consume the same frozen context and produce alternatives. Review their source changes and external checks, then select with a rationale. Humans provide intent and judgment; agents author the context.

`publication_pending` means the decision is recorded but the owner's platform landing has not been read back yet. The browser approves and lands the selected commit on the project's platform repository with the owner's own session (fast-forward only; break-glass when checks were overridden), then asks the agent layer to read `main` back. `published` is the separate publication receipt. `cargo xtask verify-live --url URL` requires one published run with completed Claude research and all three coding executions, identical research context and successful content reads by each completed attempt, actual harness overlap in the completed attempt epochs, captured revisions, evaluations matching current policy, and source history linking a labelled simulated incident to the original assumption and alternatives. It exports `artifacts/live-verification.json` on both success and incomplete verification. A development fixture selection is not human acceptance.

The normal browser selection records a human decision. An owner-controlled fixture test can explicitly send `decision_kind: "development_verification"` with its rationale; the decision and graph then identify automated development verification. Agents have no owner selection capability. `verify-live` reads existing evidence and never selects code itself.

The current policy is `retry-v2`, suite `retry-contract-v2`, environment `rust-1.94.0-evaluator-v2`. It exercises repeated retries, exponential backoff, 429, deadline boundaries, attempt clamps and unsafe methods. Existing repositories retain their original policy until `cargo xtask upgrade-policy --url URL` explicitly installs the current policy using a revision/version check. Captured candidates on the current base receive fresh evaluations; historical evaluations remain available and cannot authorize selection under the new policy.

## Agent concurrency and delegation

Hosted coding runs accept one to six initial agents. The owner can add, remove or change agents before approving each brief; one-agent updates use the same capture, evaluation and publication rules. The snapshot advertises `agent_limits.min_root_agents: 1`; a single-agent request against an older ledger returns `LEDGER_UPDATING` before any provider validation or inference. Existing run rosters remain frozen. Delegation is explicitly approved with the brief, disabled by default, and frozen for the run: at most 12 total agents through two delegation levels. Infrastructure retries retain their existing two-attempt allowance and do not consume another agent slot. Any approved request allowances are reserved durably across the run, including retries; approved per-model budgets and the Claude workspace ceiling also apply. Agent arguments cannot override child identity, provider, model, source, context or these limits.

Children produce independent alternatives from the frozen base. They are separately captured and evaluated, and no automatic merge occurs. A parent can finish while its children continue; parent expiry, failure or retry fences descendants, their eligible candidates and pending publication. Cancelling the run fences the entire tree. Durable stop requests terminate active descendant containers. An already verified canonical publication remains historical evidence. A pending landing is completed only by the owner on the platform and its readback.

Deploy both the Worker/Repo DO and the new container image. The snapshot advertises `agent_limits`; the browser retains its earlier four-agent maximum until these limits appear. The Worker refuses six-agent or delegated runs against an older ledger. The supervisor must advertise `capabilities.agent_delegation: 1` before a delegated root or child starts inference. During propagation or image rollout, retry after the compatibility error; do not bypass the guard.

Console budget approvals additionally require `capabilities.model_budgets: 1` in the repository
snapshot and supervisor health. The Worker rejects older implementations before inference.
Uncapped requests additionally require `capabilities.optional_model_requests: 1` in both.
New hosted runs record an explicit optional-limit policy and have no default request/dollar cap;
time and response limits remain. Existing runs retain their recorded historical limits.
The Repo DO migration adds a durable model-reservation ledger; existing runs keep their legacy
limits. See [run budget settings and estimate semantics](providers.md#run-budgets-in-the-console).

The checked-in and newly generated portable Wrangler configs set `containers.max_instances` to 16, providing capacity for agents and independent capture/evaluation. Existing generated configs preserve operator edits: update their ceiling explicitly when upgrading. This is an application ceiling, not a promise that every configured agent runs simultaneously; multiple runs and cold starts may queue. See Cloudflare's [container configuration](https://developers.cloudflare.com/containers/reference/wrangler-configuration/). Keep account capacity and provider quotas aligned with this setting. Agents are instructed to finish their own approach without polling for children, so waiting parents do not exhaust capacity.

Native ledger and workerd tests exercise six roots, child creation, concurrent idempotency and limits, fencing, shared requests, evaluation and rollout compatibility without inference. Passing those tests does not establish six overlapping paid harnesses or provider throughput. Record deployed overlap, actual completions, cost and capture/evaluation/publication evidence separately before claiming live scalability.

## Failed provider runs

Choose **Explain failure** on a failed approach to inspect its recorded terminal outcome. The browser displays an allowlisted diagnosis rather than raw provider responses. HTTP 402 means that provider account needs funding; 401/403 indicate credentials or access; 429 indicates quota/rate limits. Review the connection and approve a new run explicitly. Changing a key does not replay a failed paid attempt automatically.

An execution-budget stop is distinct from provider billing. Approved console runs use their frozen model budgets without a hidden CLI $1 allowance. Legacy Anthropic runs retain that CLI estimate; MiMo and ZAI do not use Anthropic pricing. The durable $20 Claude workspace ceiling applies separately. CLI dollar totals are estimates, not third-party invoices; see [Claude Code cost accounting](https://code.claude.com/docs/en/costs#using-the-usage-command). A failed harness does not produce an eligible candidate even if it edited files before stopping. Use **Restart run** to edit the brief and budgets before explicitly approving fresh work; this preserves the failed attempt's evidence.

## Recovery

Repo DO alarms recover expired leases and retry durable outbox work. Queue redelivery is expected. Late callbacks are fenced. Check the current snapshot and execution errors before restarting work. The dead-letter queue is diagnostic transport evidence; the Repo DO job record remains authoritative.

Cold container startup has a separate two-minute lease; the normal runtime budget begins when the supervisor port is ready. Startup stages and harness start are recorded as events. Launch errors become retryable job errors, rather than disappearing until lease expiry. Heartbeats extend running leases only within the attempt deadline.

Agent harnesses reserve the last ten seconds of an explicitly configured execution window for process cleanup and failure reporting. On timeout, the supervisor retains up to 2 MiB each of stdout and stderr in private memory, terminates the process group, then attempts a partial transcript upload through the owner-scoped evidence endpoint before recording failure. That upload is capped at two seconds; heartbeats remain active until failure reporting finishes. An already acknowledged transcript stays immutable. Cancelled, stale or expired attempts cannot attach evidence or extend their deadline. Raw transcript content is kept out of console and structured logs.

Before launching work, the Worker checks the supervisor's protocol and evaluator environment/suite support. Incompatible images fail before inference. Evaluation reports also identify their actual environment, which the ledger matches against policy. A rejected environment or protocol during deployment calls for waiting for the image rollout, rather than treating the candidate source as defective.

Research artifacts must include `metadata.assumptions`, an array of objects with `statement`, `metric` (string), `limit` (integer), and `path` (validated repository path). The MCP schema and agent prompt expose this contract, and malformed publication returns a corrective error. These remain agent assertions; validation makes them queryable, not externally proven.

Artifact lookup accepts canonical IDs and bare UUID aliases only within the current attempt's frozen context. The Worker authorizes the lookup, reads and verifies the immutable R2 content, then records retrieval with the canonical ID and attempt epoch. Authorization alone does not establish a content read.

Each execution container runs one attempt. The root supervisor reserves UID 1000 for untrusted code, sets no-new-privileges, becomes a Linux subreaper, and terminates and reaps that UID before exporting source or trusting evaluator output. The barrier also catches daemonized descendants that leave their process group. Docker builds run Linux regressions serially because tests intentionally share that reserved UID.

A publication conflict (platform `main` moved to another commit before the owner's fast-forward landing) blocks the repository. Preserve both commits and the decision record; inspect the platform repository and reconcile explicitly. Nothing rebases or overwrites automatically.

Migration changes must be additive and appended. Check fresh, repeat and preceding-version upgrades locally, then apply D1 migrations before deploying code that needs them. Do not modify an already-applied SQL file or remove DO class migration history. Roll back code only to versions compatible with the deployed schema.

DO SQL migration 0003 repairs existing execution graph projections from authoritative execution records, preserving node timestamps, events and evaluation evidence. It applies automatically before ledger commands; no D1 or Durable Object class migration is needed. After it applies, older binaries supporting only schema 2 refuse the database, so recovery must use a schema-3-compatible version.

No live run, deployment or acceptance should be inferred from passing local tests. Record actual commands and outcomes in `docs/progress.md`.


## Funded reviewer sandbox

Operator bootstrap on the configured development account: `node tools/provision-reviewer.mjs`. It creates `reviewer`, stores access and recovery details only in ignored `.local/reviewer/access.json` with mode 0600, and provisions encrypted Codex/Claude connections through the Worker. The operator token comes from `.local/owner-token`; neither credential is printed or passed in arguments. Provisioning is repeatable and cannot reset the workspace spend counter.

Reviewer access permits the fixed trial and sandbox selection/cancellation/recovery. Provider changes, new projects, contribution grants, policy changes and arbitrary run approvals are refused server-side. The $50 workspace allowance reserves all configured trial providers before upstream I/O. Verified usage can settle downward; unknown or failed usage remains charged. Access expires at 2026-10-23 00:00 UTC. Operator revocation uses authenticated `POST /api/admin/reviewer/revoke` with the username; it revokes sessions and further inference.

For blocked repositories, **Recover repository** invokes `resync_repository` with expected version and pending decision. The Worker derives the observed head from the platform repository's `main`, never from caller JSON. The ledger retains conflicting decision history. A matching target confirms publication; a different target reconciles to observed source and clears stale site metadata. Stale recovery requests are rejected.

Known container allocation/rate-limit errors defer dispatch with durable backoff and fence the old epoch without consuming the execution-attempt allowance. Other boot failures retain the ordinary retry limit. HTTPS interception requires the ephemeral Cloudflare CA installed at runtime, before harnesses start; it cannot be installed during Docker image construction.
