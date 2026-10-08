# Implementation ledger — docs/implementation-plan.md

## Environment

2026-10-07: workspace initially contains only context exports; no Git repository or source. Rust 1.94, Node 24, Wrangler 4.147, Docker 29.8, Codex 0.161 and Claude 2.1.293 available. Wrangler authenticated with Workers, Artifacts, Queues and Containers scopes. Provider API keys absent from shell.

## Rulings

- Ruling: Initialize a new feature-branch repository in the requested empty project directory; no existing branch/worktree needs protection. Cost if wrong: local repository metadata can be removed without touching source.
- Ruling: The approved plan is the specification; there is no separate detailed superpowers task document. Track milestone evidence here instead of manufacturing task scripts/commits for nonexistent briefs. Cost if wrong: the ledger must be expanded to finer tasks.
- Ruling: Continue implementing local and deployable behavior while live provider credentials are pending. Never substitute synthetic agent results for live acceptance evidence. Cost if wrong: deployment work may need account-specific adjustment.

## Interface preflight

- P1 → P2/P3: execution identity is issued by the ledger; MCP completion is a hint; trusted capture/evaluation callbacks use internal routes.
- P3 → P4: logical HEAD and published HEAD are separate fields; UI must not report selected code as published.
- P1 → P4: ordered events drive replay and disposable projections; D1 cannot authorize acceptance.

## Evidence

- P1 domain/ledger: 11 tests passed (`cargo test -p yoneda-core -p yoneda-app`), after observed failing tests against stubs. Covers canonical evidence, path safety, atomic outbox, duplicate claims, epoch fencing, shared frozen research, acceptance CAS/idempotency, separate logical/published heads and cancellation. Cloudflare integration remains pending.
- P0: Rust wasm32 target installed. Secrets Store metadata verified: active `Claude` and `Codex`; values were not read. Bindings will resolve them in Worker egress handlers.
- P0/P1: actual workers-rs Wasm build passed; `strip=debuginfo` preserves required wasm-bindgen metadata (upstream workers-rs issue 1014). R2, D1 and five development queues provisioned; D1 migration 0001 applied remotely.
- P3: external retry oracle and forged/incomplete-report tests observed RED against stubs, then GREEN. Policy checks run in Rust outside candidate-controlled processes.
- Repository standards: root AGENTS.md researched from primary sources and applied. Rust application and runner, TypeScript adapters and browser feature styles split by responsibility. Numbered DO migrations have checksum drift protection; upgrade test RED (missing schema_migrations) → GREEN (8 app tests).
- Local platform integration: five workerd tests passed, covering DO transactions, eviction, ordered replay, duplicate claims, trusted clock, R2 immutable writes and authentication. Uses an explicit no-dispatch test entrypoint; no inference results fabricated.
- Runtime Docker image builds for linux/amd64; Node 24 replaces the older Debian Node package to meet the pinned Claude CLI engine requirement. Live container boot and provider runs remain pending.

- Full required local gate passed: native Rust tests, rustfmt, Clippy warnings denied, workers-rs Wasm, TypeScript/Biome, workerd and Vite production build. Repeated after evidence and session changes; the latest alarm/recovery changes are being checked separately.
- Additional regressions observed RED → GREEN: descriptor-relative parent/final symlink rejection, stopping background command children, model/transcript retention, publication graph receipt, scoped evidence reads, R2 digest tampering and signed HttpOnly sessions/cross-origin rejection.
- Recovery regressions observed RED → GREEN in workerd: preserve the earliest pending alarm, use workers-rs Duration offsets correctly, and clear failed-initialization alarms. SDK source confirms i64 ScheduledTime values are offsets, not timestamps.
- First development deployment succeeded (Worker version 92a8177b-ae83-4f9a-bfd0-b58c9b980a74). Real Artifacts seed commit 16369ed28a684f79c7aafb74a9014af0bcb58198. Sonnet research completed and launched overlapping Codex/Luna and Claude/Sonnet coding attempts with the identical research artifact. Both Codex candidates captured real fork commits and passed independent clean/offline build and external behavioral checks. The Claude coding attempt is still being diagnosed; no human acceptance or canonical publication claimed.
- Local `cargo xtask dev` reached Wrangler ready at http://localhost:8787 with the Docker image and all bindings; full live behavior is verified separately on Cloudflare.
