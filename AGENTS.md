# YonedaRepo engineering guide

YonedaRepo is a Context Graph platform on Cloudflare. Rust owns domain rules, durable state transitions, the native runner, MCP, capture and verification. TypeScript is the browser and the thin adapter for Cloudflare SDK capabilities unavailable in Rust.

## Layout and boundaries

- `backend/crates/yoneda-core`: typed contracts and pure validation. No Cloudflare or network dependencies.
- `backend/crates/yoneda-app`: application commands and authoritative transactional ledger, with native SQLite and DO adapters. Domain operations must be shared by local and deployed execution.
- `backend/crates/yoneda-cloudflare`: binding interoperability; no product policy.
- `backend/crates/yoneda-worker`: Rust Durable Objects and Worker integration.
- `backend/crates/yoneda-runtime`: native supervisor, harnesses, scoped MCP, Git capture, clean evaluation and publication.
- `cloudflare/worker`: focused TypeScript SDK adapters, authentication and transport.
- `frontend`: browser features and components; no secrets or authoritative decisions.
- `cloudflare/migrations`: append-only D1 discovery migrations. DO schema migrations live with `yoneda-app`.
- `cloudflare/sites` and `cloudflare/containers`: isolated website serving and the pinned native runtime image. Wrangler environment configuration lives in `cloudflare/wrangler*.jsonc`.
- `shared`: browser/adapter contracts derived from the Rust provider registry; no secrets or authoritative state.
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

## References

Use these as guidance, adapted to the actual repository rather than copied wholesale:
[AGENTS.md format](https://agents.md/), [Codex instruction discovery](https://developers.openai.com/codex/guides/agents-md), [OpenAI Codex repository guide](https://github.com/openai/codex/blob/main/AGENTS.md), [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/checklist.html), [Cloudflare Workers testing](https://developers.cloudflare.com/workers/testing/vitest-integration/), [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
