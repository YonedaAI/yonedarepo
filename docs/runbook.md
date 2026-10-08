# Runbook

For personal signup, provider setup and website publishing, see [the website workflow](website-workflow.md). External agents use [repository-scoped MCP and Git keys](remote-mcp.md). The [retry fixture walkthrough](demo.md) is an operator verification example.

## Local prerequisites

Use Rust from `rust-toolchain.toml`, Node 24, pnpm 11, Docker and `worker-build` 0.8.7. `cargo xtask doctor` checks installed commands and Docker availability. `cargo xtask setup` installs locked JS dependencies and creates an ignored owner token with private file permissions.

`cargo xtask check` is the required local gate: Rust formatting, Clippy with warnings denied, native tests, the actual Wasm build, TypeScript/Biome, workerd integration tests and browser production build. It requires no provider keys, Cloudflare login or inference. The test Worker deliberately withholds execution dispatch so real SQLite/R2 behavior can be tested without launching models.

`cargo xtask dev` builds assets and Wasm, applies D1 migrations locally and starts Wrangler. For hot reload, run `pnpm --dir web dev` beside it. Full agent execution needs Artifacts access and provider bindings; local unit/integration tests establish behavior without claiming a live agent run. Cloudflare product capabilities that require remote services must pass the live gate separately.

## Development account

`wrangler.jsonc` contains this project's development account, Secrets Store IDs and resource names. Those identifiers are configuration, not secret values. For another account, authenticate using `pnpm exec wrangler login`, update the account and store IDs, provision an R2 bucket, D1 database and queues, then update their identifiers before deployment. Do not reuse production resources for tests.

The provisioned resources are `yonedarepo-dev-objects`, `yonedarepo-dev-index`, `yoneda-dev-{agent,capture,evaluate,publish}` and `yoneda-dev-dead-letter`. D1 discovery uses `migrations/`; repository DO schema uses `crates/yoneda-app/src/migrations/`.

Secrets Store names are `Codex`, `Claude`, `MiMo` and `ZAI`, with Workers service scope. Bindings are `OPENAI_KEY`, `ANTHROPIC_KEY`, `MIMO_KEY` and `ZAI_KEY`. Personal accounts use their encrypted BYOK vault instead. See [vault and budget operation](providers.md). Never fetch these values into the shell, browser or model environment. Regular Worker secret `OWNER_TOKEN` protects the owner API in development. `cargo xtask deploy` sets it from the private local token file, applies D1 migrations and deploys the built Worker/container.

Cloudflare activates Worker code before a container image rollout completes. After an image change, inspect the application's rollout in the Cloudflare dashboard and wait for completion before starting paid demos or installing a policy that needs the new evaluator. `pnpm exec wrangler containers list --json` and `containers info APPLICATION_ID --json` show application version/image and health; a successful deploy command alone proves only that rollout started. For a browser/Worker-only update that does not need a new image, use `pnpm exec wrangler deploy --containers-rollout=none`. Keep protocol changes compatible through the mixed-version window. See [Cloudflare rollout behavior](https://developers.cloudflare.com/containers/configuration/rollouts/).

Worker and Durable Object code also propagate separately. Before starting paid exploration, the Worker checks the repository snapshot's artifact-read capability; `LEDGER_UPDATING` means retry after propagation, with no new run created. A successful Worker upload does not prove that an existing Repo DO has adopted its code. Cloudflare documents the [temporary code-version mismatch](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).

For a deliberate development cutover after active runs have stopped, `pnpm exec wrangler versions deploy VERSION_ID@100% --durable-objects-code-update-mode immediate --yes` promotes the existing tested version with an explicit DO update mode. Confirm the repository capability afterward; promotion success is not the readiness signal. The [Wrangler command reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions-deploy) documents immediate and bounded deferred modes.

For Cloudflare Access, protect the host with an Access policy and configure `ACCESS_TEAM_DOMAIN` (host only) and `ACCESS_AUD`. The Worker verifies JWT issuer, signature and audience. An unverified `cf-access-jwt-assertion` is never sufficient. The browser can then use the Access session and Live DO WebSocket; owner connections use an expiring, signed HttpOnly session cookie. Both support Live DO WebSockets and periodic authoritative snapshot resync.

## Legacy retry fixture workflow

Run `cargo xtask seed-demo --url URL` once. Bootstrap issues a five-minute repository-scoped Git token to the trusted local setup command only; provider keys remain in the Worker. The fixture push establishes a real Artifacts commit before the ledger is initialized. Repeating seed keeps existing source and ledger data.

`cargo xtask demo --url URL` starts real inference. Defaults are `gpt-5.6-luna` and `claude-sonnet-4-6` in Wrangler variables. Provider handlers force the configured model, restrict endpoints and cap each attempt at 24 model requests, 256 KiB per request and 4096 output tokens per request; Claude CLI also has a $1 attempt budget. Do not silently upgrade a model. Containers are capped at six instances, agents at ten minutes, evaluators at two minutes, and infrastructure attempts at two.

Open the browser and connect with the workspace owner token from `.local/owner-token` (paste it or choose the token file), or use the configured Cloudflare Access login. Provider keys are different credentials and stay in Secrets Store. Describe the change in Exploration: research agents inspect the repository and publish guidance and assumptions, then three coding agents consume the same frozen context and produce alternatives. Review their source changes and external checks, then select with a rationale. Humans provide intent and judgment; agents author the context.

`publication_pending` means the decision is recorded but canonical Git readback is still pending. `published` is the separate publication receipt. `cargo xtask verify-live --url URL` requires one published run with completed Claude research and all three coding executions, identical research context and successful content reads by each completed attempt, actual harness overlap in the completed attempt epochs, captured revisions, evaluations matching current policy, and source history linking a labelled simulated incident to the original assumption and alternatives. It exports `artifacts/live-verification.json` on both success and incomplete verification. A development fixture selection is not human acceptance.

The normal browser selection records a human decision. An owner-controlled fixture test can explicitly send `decision_kind: "development_verification"` with its rationale; the decision and graph then identify automated development verification. Agents have no owner selection capability. `verify-live` reads existing evidence and never selects code itself.

The current policy is `retry-v2`, suite `retry-contract-v2`, environment `rust-1.94.0-evaluator-v2`. It exercises repeated retries, exponential backoff, 429, deadline boundaries, attempt clamps and unsafe methods. Existing repositories retain their original policy until `cargo xtask upgrade-policy --url URL` explicitly installs the current policy using a revision/version check. Captured candidates on the current base receive fresh evaluations; historical evaluations remain available and cannot authorize selection under the new policy.

## Recovery

Repo DO alarms recover expired leases and retry durable outbox work. Queue redelivery is expected. Late callbacks are fenced. Check the current snapshot and execution errors before restarting work. The dead-letter queue is diagnostic transport evidence; the Repo DO job record remains authoritative.

Cold container startup has a separate two-minute lease; the normal runtime budget begins when the supervisor port is ready. Startup stages and harness start are recorded as events. Launch errors become retryable job errors, rather than disappearing until lease expiry. Heartbeats extend running leases only within the attempt deadline.

Before launching work, the Worker checks the supervisor's protocol and evaluator environment/suite support. Incompatible images fail before inference. Evaluation reports also identify their actual environment, which the ledger matches against policy. A rejected environment or protocol during deployment calls for waiting for the image rollout, rather than treating the candidate source as defective.

Research artifacts must include `metadata.assumptions`, an array of objects with `statement`, `metric` (string), `limit` (integer), and `path` (validated repository path). The MCP schema and agent prompt expose this contract, and malformed publication returns a corrective error. These remain agent assertions; validation makes them queryable, not externally proven.

Artifact lookup accepts canonical IDs and bare UUID aliases only within the current attempt's frozen context. The Worker authorizes the lookup, reads and verifies the immutable R2 content, then records retrieval with the canonical ID and attempt epoch. Authorization alone does not establish a content read.

Each execution container runs one attempt. The root supervisor reserves UID 1000 for untrusted code, sets no-new-privileges, becomes a Linux subreaper, and terminates and reaps that UID before exporting source or trusting evaluator output. The barrier also catches daemonized descendants that leave their process group. Docker builds run Linux regressions serially because tests intentionally share that reserved UID.

A remote publication conflict blocks the repository. Preserve both commits and the decision record; inspect Artifacts HEAD and reconcile explicitly. The MVP does not provide automatic rebase or overwrite. A publisher that exhausts attempts must leave the logical/published split visible for operator recovery.

Migration changes must be additive and appended. Check fresh, repeat and preceding-version upgrades locally, then apply D1 migrations before deploying code that needs them. Do not modify an already-applied SQL file or remove DO class migration history. Roll back code only to versions compatible with the deployed schema.

DO SQL migration 0003 repairs existing execution graph projections from authoritative execution records, preserving node timestamps, events and evaluation evidence. It applies automatically before ledger commands; no D1 or Durable Object class migration is needed. After it applies, older binaries supporting only schema 2 refuse the database, so recovery must use a schema-3-compatible version.

No live run, deployment or acceptance should be inferred from passing local tests. Record actual commands and outcomes in `docs/progress.md`.
