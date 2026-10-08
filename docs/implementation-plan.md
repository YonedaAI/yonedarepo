# YonedaRepo MVP implementation contract

The approved design is a Context Graph and agent control plane above Cloudflare Artifacts. Rust owns platform behavior; the browser is TypeScript. Cloudflare owns runtime and storage; Codex and Claude APIs provide inference.

## Milestones

1. P0: pin dependencies; prove Rust/Wasm, DO SQLite transactions, R2, Queues, containers, Artifacts forks and conditional publication, and both harnesses with shared stdio MCP.
2. P1: authoritative Repo DO ledger, graph, immutable evidence, transactional outbox, leases and event replay.
3. P2: native runner, Codex/Claude adapters, scoped MCP, concurrent executions, independent source capture.
4. P3: independent clean evaluation, policy gates, idempotent selection, conditional Git publication and recovery.
5. P4: browser exploration/comparison, graph navigation, why-by-revision/path, incident observations, D1 discovery projection.
6. P5: fault tests, reproducible deploy/seed/demo/verify commands, license, source and runbook.

## Invariants

- Repo DO SQLite is authoritative; D1 and Live DO are projections.
- Every mutation, event, and outbox job commits together. No external I/O inside database transactions.
- Source lives in Artifacts; context/evidence payloads in R2; both are immutable when referenced.
- Epoch and deadline fence attempts. Duplicate delivery must not duplicate authoritative outcomes.
- Only the acceptance service selects logical HEAD. Required checks must pass against the exact candidate, suite, environment and policy.
- Selection and verified Git publication are distinct states. Block subsequent acceptance and new runs while publication is unresolved.
- Publisher uses an expected-old-ref lease and verifies ancestry. Divergence blocks publication without overwriting remote changes.
- Coding containers receive no provider, storage, or canonical-write credentials. Outbound handlers scope all operations to the container attempt.
- Capture treats files as untrusted data and constructs fresh Git objects in a separate container.
- Evaluation verdicts are determined outside candidate-controlled code; agent reports are assertions.
- Graph edges distinguish delivered context from claimed influence. Preserve alternative candidates, rationale and bounded assumptions.

## Acceptance

Show research → three overlapping Codex/Claude attempts → immutable captured commits → clean checks → human decision → verified canonical publication → a simulated incident traversing the original assumption and rejected alternatives. Verify duplicate delivery, restart recovery, stale HEAD/version, idempotency misuse, expired completion, unsafe source paths, forbidden artifact access, publication acknowledgment loss, graph coverage, and event reconnect.

Defaults: one owner workspace, Access-protected mutations, three parallel coding attempts, ten-minute execution deadline, two-minute evaluation deadline, two infrastructure attempts. Defer semantic merge, automatic rebase, generic DAG authoring, enterprise tenancy, and automated garbage collection.
