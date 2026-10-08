# Runbook

## Local prerequisites

Use Rust from `rust-toolchain.toml`, Node 24, pnpm 11, Docker and `worker-build` 0.8.7. `cargo xtask doctor` checks installed commands and Docker availability. `cargo xtask setup` installs locked JS dependencies and creates an ignored owner token with private file permissions.

`cargo xtask check` is the required local gate: Rust formatting, Clippy with warnings denied, native tests, the actual Wasm build, TypeScript/Biome, workerd integration tests and browser production build. It requires no provider keys, Cloudflare login or inference. The test Worker deliberately withholds execution dispatch so real SQLite/R2 behavior can be tested without launching models.

`cargo xtask dev` builds assets and Wasm, applies D1 migrations locally and starts Wrangler. For hot reload, run `pnpm --dir web dev` beside it. Full agent execution needs Artifacts access and provider bindings; local unit/integration tests establish behavior without claiming a live agent run. Cloudflare product capabilities that require remote services must pass the live gate separately.

## Development account

`wrangler.jsonc` contains this project's development account, Secrets Store IDs and resource names. Those identifiers are configuration, not secret values. For another account, authenticate using `pnpm exec wrangler login`, update the account and store IDs, provision an R2 bucket, D1 database and queues, then update their identifiers before deployment. Do not reuse production resources for tests.

The provisioned resources are `yonedarepo-dev-objects`, `yonedarepo-dev-index`, `yoneda-dev-{agent,capture,evaluate,publish}` and `yoneda-dev-dead-letter`. D1 discovery uses `migrations/`; repository DO schema uses `crates/yoneda-app/src/migrations/`.

Secrets Store names are `Codex` and `Claude`, with Workers service scope. Bindings are `OPENAI_KEY` and `ANTHROPIC_KEY`. Never fetch these values into the shell, browser or model environment. Regular Worker secret `OWNER_TOKEN` protects the owner API in development. `cargo xtask deploy` sets it from the private local token file, applies D1 migrations and deploys the built Worker/container.

For Cloudflare Access, protect the host with an Access policy and configure `ACCESS_TEAM_DOMAIN` (host only) and `ACCESS_AUD`. The Worker verifies JWT issuer, signature and audience. An unverified `cf-access-jwt-assertion` is never sufficient. The browser can then use the Access session and Live DO WebSocket; owner connections use an expiring, signed HttpOnly session cookie. Both support Live DO WebSockets and periodic authoritative snapshot resync.

## Live workflow and budgets

Run `cargo xtask seed-demo --url URL` once. Bootstrap issues a five-minute repository-scoped Git token to the trusted local setup command only; provider keys remain in the Worker. The fixture push establishes a real Artifacts commit before the ledger is initialized. Repeating seed keeps existing source and ledger data.

`cargo xtask demo --url URL` starts real inference. Defaults are `gpt-5.6-luna` and `claude-sonnet-4-6` in Wrangler variables. Provider handlers force the configured model, restrict endpoints and cap each attempt at 24 model requests, 256 KiB per request and 4096 output tokens per request; Claude CLI also has a $1 attempt budget. Do not silently upgrade a model. Containers are capped at six instances, agents at ten minutes, evaluators at two minutes, and infrastructure attempts at two.

Open the browser, connect the owner session, wait for research and overlapping coding executions, review diffs and external checks, then select with a rationale. `publication_pending` means the decision is recorded but canonical Git readback is still pending. `published` is the separate publication receipt. `cargo xtask verify-live --url URL` requires recorded completed harnesses, publication and source history; it exports evidence under ignored `artifacts/`.

## Recovery

Repo DO alarms recover expired leases and retry durable outbox work. Queue redelivery is expected. Late callbacks are fenced. Check the current snapshot and execution errors before restarting work. The dead-letter queue is diagnostic transport evidence; the Repo DO job record remains authoritative.

A remote publication conflict blocks the repository. Preserve both commits and the decision record; inspect Artifacts HEAD and reconcile explicitly. The MVP does not provide automatic rebase or overwrite. A publisher that exhausts attempts must leave the logical/published split visible for operator recovery.

Migration changes must be additive and appended. Check fresh, repeat and preceding-version upgrades locally, then apply D1 migrations before deploying code that needs them. Do not modify an already-applied SQL file or remove DO class migration history. Roll back code only to versions compatible with the deployed schema.

No live run, deployment or acceptance should be inferred from passing local tests. Record actual commands and outcomes in `docs/progress.md`.
