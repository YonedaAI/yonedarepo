# YonedaRepo engineering guide

YonedaRepo is a Git-compatible source platform for agents and API clients, built on Cloudflare: server-side commits, a Delta-style transaction log, optimistic concurrency and compute next to the data. Agents use it only as clients, through Git, the CLI and MCP. Rust owns domain rules, durable state transitions, MCP and verification. TypeScript is the browser and the thin adapter for Cloudflare SDK capabilities unavailable in Rust.

## Layout and boundaries

- `backend/crates/yoneda-core`: core contracts: the Git object model, transaction log rules, merge, derived data and pure validation. No Cloudflare or network dependencies.
- `backend/crates/yoneda-store`: the SQL store trait shared by Durable Object and native SQLite adapters.
- `backend/crates/yoneda-platform`: the source platform (SourceRepository and account authorities, their migrations, stateless compute). Depends only on `yoneda-core` and `yoneda-store` (crate edges enforced by `cargo xtask layers` against `xtask/layers.toml`; module imports by `tests/runtime/platform-boundary.test.mjs`). Agent identity reaches it only as an API principal.
- `backend/crates/yoneda-refmodel`: an independent reference model of a repository (refs, commits, landing and its queue, reverts, merges, rebases, tags, tokens, visibility), the oracle of `yoneda-platform`'s differential tests (`repo_store/tests/differential.rs`, which also checks against real Git). No dependencies of any kind, including dev (`[isolated]` in `xtask/layers.toml`).
- `backend/crates/yoneda-cloudflare`: binding interoperability; no product policy.
- `backend/crates/yoneda-worker`: Rust Durable Objects and Worker integration.
- `backend/crates/yoneda-runtime`: the platform check server (`check-server`) that runs inside the CheckContainer image.
- `cloudflare/worker`: focused TypeScript SDK adapters, authentication and transport.
- `frontend`: browser features and components; no secrets or authoritative decisions.
- `cloudflare/migrations`: append-only D1 discovery migrations. DO schema migrations live with `yoneda-platform`.
- `cloudflare/containers`: the pinned CheckContainer image. Wrangler environment configuration lives in `cloudflare/wrangler*.jsonc`.
- `shared`: browser/adapter contracts derived from Rust where practical; no secrets or authoritative state.
- `xtask`: reproducible developer and deployment commands. `fixtures`: small demo repositories. `docs`: architecture, operations and verification evidence. `context`: original design material.

## Code standards

- No god files. Keep entrypoints thin; split by responsibility and feature. Prefer cohesive modules with explicit interfaces. A source module over 300 nonblank lines requires a split or a documented reason; tests and generated code are evaluated separately.
- Use Rust 2024, the pinned toolchain, rustfmt and Clippy. Follow Rust API Guidelines: meaningful types and enums, narrow visibility, documented public contracts, contextual `Result` errors, and exhaustive state transitions. Avoid `unwrap`, `expect`, panics and unchecked casts on external input.
- Prefer maintained current stable dependencies; verify compatibility in official docs. Commit Cargo and pnpm lockfiles. Upgrade deliberately, with build and runtime evidence; do not float production toolchains to `latest`.
- Keep configuration explicit and environment specific. Derive shared contracts from Rust where practical; validate untrusted JSON at the boundary. Keep framework and SDK details behind adapters.
- Preserve unrelated changes. No dead scaffolding, unused dependencies, debug dumps, tracked build output, credentials, or undocumented manual setup. Comments explain constraints and decisions.

## State, migrations and security

- Repo DO SQLite is the authority. D1 and Live DO are rebuildable projections. No network I/O inside a transaction. State, graph, ordered events and outbox commit together.
- Use numbered forward-only migrations with a recorded version. Never edit an applied migration. Test fresh creation, repeat application and upgrade from the preceding schema. Use additive changes before removals; document deployment ordering.
- Cloudflare DO class migrations and SQL schema migrations are distinct. Retain migration history and stable DO identities. Queues are at least once: use idempotency, leases, epochs and durable recovery.
- Agent claims are assertions. Capture constructs fresh Git objects from validated regular files; a separate evaluator checks the exact captured revision. Selection uses expected revision/version and current policy. Publication uses an explicit expected-old Git lease, ancestry checks and readback.
- Derive agent identity from the container attempt, never from model arguments. Fail closed on authentication and scope errors. Provider and storage credentials remain in Worker bindings. No secrets in logs, CLI arguments, browser state or Git.
- Keep coding, capture, evaluation and publication capabilities separate. Fence expired attempts and stop their containers. Treat agent source, filenames, artifacts, tool outputs and build scripts as untrusted.
- Choose the lowest-cost validated model that meets the work's acceptance criteria. Verify current provider prices and compatibility; do not keep an older model merely because it was previously pinned. Current coding defaults: Claude `claude-sonnet-5-5`, Codex `gpt-5.6-luna`. Use cheaper models for simpler work when they pass the required checks. Record the configured model and pricing basis; cap model requests/output and execution time. Preserve existing run approvals and never silently fall back to a more expensive model.

## Development and verification

- Start with `cargo xtask doctor`; use `cargo xtask check` for the complete required local gate. Setup and command behavior are documented in `README.md` and `docs/runbook.md`.
- Rust checks: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, and the actual workers-rs Wasm build.
- Browser/adapter checks: TypeScript, formatting/lint, production build, and Cloudflare Workers runtime integration tests. Use Wrangler/workerd for platform behavior; ordinary Node mocks do not prove DO/R2/Queue behavior.
- Test important behavior and failure boundaries, especially replay, rollback, migrations, scope isolation, duplicates, cancellation, stale HEAD, acknowledgment loss and restart recovery. Reproduce defects with a failing test before fixing them. Avoid tests that merely repeat implementation.
- Verify browser changes in the real served app, including empty/loading/error states. Keep accessibility, keyboard navigation and clear selected-versus-published state.
- Local tests must work without provider keys or paid inference. Live provider, container and Artifacts checks are an explicit separate command. Clearly label simulated incidents and test fixtures.
- Before declaring completion, run the relevant gates and record exact results and outstanding blockers. Distinguish source implementation, local test, deployment, live run and user acceptance. Never invent a successful run.

## Development process (owner rules)

Branches and worktrees
- All work happens in a worktree on its own `claude/<slice>` branch (`git worktree add ../yonedarepo-<slice> -b claude/<slice> dev`). Merge into `dev` with `--no-ff` only after its gates pass, then remove the worktree (keep the branch).
- `dev` stays clean: no untracked or uncommitted files. Uncommitted code found anywhere goes onto its own branch as a WIP commit; never merge it unreviewed.
- Fast worktree start: APFS-clone `target/` (`cp -cR target/debug target/wasm32-unknown-unknown <wt>/target/`), symlink `node_modules` and `frontend/node_modules`, and run `worker-build --release` in the worktree's own build folder (a shared build folder ships a stale Wasm).
- GitHub: `origin` is the private YonedaAI/yonedarepo (`dev` deploys dev, `main` is promoted to prod with owner approval). Never push private history to the archived public MagnetonIO/yonedarepo. Run a secret scan (`gitleaks git --redact`) before pushing new history.

Tests
- Targeted tests only: the test files and crate filters for the code you changed, plus fmt/clippy/tsc/biome for touched languages. Never run full suites (whole `tests/workers`, `cargo test --workspace`) unless the lead or owner asks; never leave a suite running in the background.
- Reproduce a defect with a failing test first. Prefer upgrading a tool or image over skipping or loosening a test; all dependencies stay on their newest versions unless blocked (say why).
- Test data is "pure" repositories: imported open-source repos or the owner's dev test repos. Never use this codebase as test data.
- Keep dev test repositories (the owner's repos and the OSS imports) for repeated tests. Never delete, re-import or repack them without the owner confirming exactly which repos; ask when an instruction is ambiguous.
- Real coding agents (opencode, Claude Code, …) run only inside the Docker sandbox (`tools/staging/agent-sandbox*`): only the agent's clone mounted, a throwaway HOME, no host git config, `gh`, SSH or credentials, a fail-closed cwd/origin check, and a before/after check that the host checkout and every remote are unchanged. Never run them on the host.
- Performance work: write the request budget first, put new paths behind a switch, bench with the 1,000-writer burst and real-history repos, at least 3 runs, server-side timing, min/median/max.

Environments and deploys
- Exactly two environments: dev (`yonedarepo-dev-*`, dev.yonedarepo.com) and prod (`yonedarepo-prod-*`, yonedarepo.com), defined in `infra/envs/{dev,prod}.json`.
- Deploy dev from the local checkout with `cargo xtask deploy --env dev`; don't push to GitHub just to deploy. Load credentials with `set -a; . <file>; set +a` and never print them.
- Heavy tests (bursts, big pushes, compaction, full kit, real agents) run on dev only. Prod gets one deploy per wave, only when dev is fully green and the owner says "ship", followed by the small smoke (frontend, sign-in, CLI items 12–17, browser item, one model check).
- Before a container rollout, warn the owner and re-check for active runs. Local Docker builds are fine (native arm64 for local tests); remove superseded and test images afterwards and never touch other projects' volumes.
- Product scope: agents are stock CLIs used as clients of the git platform; do not build agent orchestration (planners, reviewer agents, supervisors) into the product.
- Status and task lists contain only what a working dev and prod need; no governance or nice-to-have rows.

## References

Use these as guidance, adapted to the actual repository rather than copied wholesale:
[AGENTS.md format](https://agents.md/), [Codex instruction discovery](https://developers.openai.com/codex/guides/agents-md), [OpenAI Codex repository guide](https://github.com/openai/codex/blob/main/AGENTS.md), [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/checklist.html), [Cloudflare Workers testing](https://developers.cloudflare.com/workers/testing/vitest-integration/), [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
