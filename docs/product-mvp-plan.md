# YonedaRepo product MVP implementation plan

Approved specification: the conversation's October 8 plan, with standard typed context, username/password signup, BYOK, concurrent hosted agents, static website hosting, and local agents that read and contribute through MCP. This replaces fixture-only acceptance; docs/implementation-plan.md retains the foundation contract.

## Global constraints

Rust owns domain policy and durable transitions; reuse native SQLite and DO adapters. Workers and Artifacts provide platform and Git storage. Repo DO authority, atomic graph/events/outbox, immutable evidence, scoped capabilities, independent capture/evaluation and leased publication remain mandatory. Preserve existing changes and applied migrations. Modules stay below 300 nonblank lines. Tests run without inference; real provider checks are separate. MiMo and ZAI are preferred for iterative live testing; Claude testing is authorized under a USD 20 total durable budget with per-request reservations shared across parallel attempts and restarts. No expensive fallback.

## Task 1: Repair graph state

Interfaces: authoritative entity writes and graph projection share a transaction; UI selection resolves by ID.

1. Run cancellation-during-evaluation regression. Expected: RED, evaluating instead of cancelled.
2. Resolve evaluator execution identity, fence and cancel jobs, synchronize stateful run/candidate/execution nodes. Add regressions before fixes and forward migration for old state.
3. Refresh selected graph details from new snapshots. Verify native and workerd migration replay, rollback, cancellation and duplicate completion.
4. Run cargo xtask check. Expected: all required gates pass. Commit only the graph repair and its tests.

## Task 2: Typed context and general execution

Interfaces: ContextRecord, context relationships, RunSpec and BuildProfile feed GUI, MCP, evaluator and capture.

1. RED tests for standard context types, validated references, immutable/superseding records, attribution, bounded search, nonnumeric assumptions and general run profiles.
2. Implement Rust contracts and application commands, additive migrations and legacy compatibility. Context types: intent, requirement, constraint, assumption, finding, alternative, proposed_decision, question. Agent assertions never confer approval or verification.
3. Replace fixture prompts with approved brief/context/instructions; schedule two independent attempts concurrently. Generalize clean build/test profiles and preserve the retry oracle only as a fixture.
4. Make Git/source transfer binary-safe and bounded with explicit unsupported-layout errors. Run Rust and workerd suites. Expected: real general workflows pass without provider keys.

## Task 3: Accounts, BYOK and repositories

Interfaces: authenticated Principal and workspace authority own sessions, grants, encrypted credentials and project discovery; repository commands enforce workspace ownership.

1. RED tests for signup/login/recovery/revocation, ownership isolation, secret handling and onboarding.
2. Implement Rust workspace DO, native adapter, migrations, password/session crypto adapter and HTTPS auth routes. Recovery codes avoid an external mail dependency. D1 remains a discovery projection.
3. Add encrypted provider vault and scoped egress for OpenAI, Anthropic, MiMo and ZAI. Discover official compatible APIs; no client-supplied upstream URLs, identities or models outside configured scope.
4. Browser project creation and public HTTPS Git import use Artifacts; failures are resumable and visible. Existing fixture becomes administrator-owned. Run cross-account workerd tests. Expected: no global-key fallback and no cross-workspace reads or writes.

## Task 4: User workflow, comparison and hosting

Interfaces: brief approval starts RunSpec; independent evaluator emits immutable deployment manifest; human decision publishes source before deployment alias.

1. Implement signup, provider settings, project creation, editable brief and concurrent intent views. Show real progress and failures, site/code/context/check comparison and selection reasons.
2. Implement typed graph search/filter/expand, exact revision/path why, evidence, links and continuation from existing context.
3. Clean evaluator builds static assets from exact candidate revision; immutable R2 assets are served by an isolated-origin sites Worker. Failed deployment preserves previous serving version. Add failure/isolation tests first.
4. Verify served browser empty/loading/error/success states and keyboard use. Expected: a new user can create, build, compare, approve and publish without CLI setup.

## Task 5: External agents and Git contributions

Interfaces: remote Streamable HTTP MCP and authenticated Git broker share Rust context/auth rules with the GUI.

1. RED tests for scoped tokens, revoked/expired grants, graph queries, context attribution, contribution fencing and canonical-write denial.
2. Implement repository context/search/get/publish/artifact tools, attempt begin/submit and status. Web generates revocable repository grants, with tested Codex/Claude env-reference setup.
3. Broker Git reads and isolated contribution writes without exposing Artifacts credentials. Submission fences writes, independently captures the submitted revision, evaluates and awaits human decision.
4. Run workerd and native tests. Expected: a fresh local agent finds prior intent/alternatives/decision/evidence and submits a checked follow-up candidate.

## Task 6: Release and submission

1. Run cargo xtask check and a fresh-context whole-branch review. Fix important findings through RED/GREEN regressions. Separate source, local verification, deployment and live evidence.
2. Deploy compatible migrations/bindings/adapters; verify actual DO adoption, two cheap agents overlapping, independent captures/checks, user-selected publication, isolated hosted site and fresh-agent MCP continuation.
3. Publish permissive Apache-2.0 source and local/deployed/MCP instructions. Produce an approximately eight-minute demonstration and submission checklist. Never label an automated selection as user approval or an old fixture as generic-product acceptance.

## Review focus

Cross-account scope through HTTP/MCP/Git/Live/R2/provider egress; replay and idempotency across DOs; secret leakage; candidate-controlled check policy; mutable contribution refs; unsafe paths/binaries/symlinks; typed claims mistaken for verified facts; source-versus-hosted-site revision drift; DO code adoption and migration order; clear selected/published/deployed status.
