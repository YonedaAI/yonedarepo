# YonedaRepo current-state architecture

Source snapshot: October 14, 2026 (implementation `fa07681`), with the agent layer re-hosted on the
source platform's public API (N8, October 20, 2026). This document describes the current code and
Cloudflare configuration. Deployment and live acceptance evidence are recorded separately in
[UI workflow evidence](ui-workflow-evidence.md).

YonedaRepo has four main parts: a React frontend, a Rust application core, Cloudflare services
for coordination and storage, and isolated containers for native agent execution.

## Code layout

```text
frontend/                  React, TypeScript, Vite and React Flow
backend/crates/
  yoneda-core/             Types, contracts, validation and provider registry
  yoneda-app/              Transactional state, graph, scheduling and migrations
  yoneda-cloudflare/       Rust-to-Cloudflare binding adapters
  yoneda-worker/           Rust Durable Objects compiled to Wasm
  yoneda-runtime/          Check server that runs inside the CheckContainer image
cloudflare/
  worker/                 Authentication, HTTP/MCP and SDK adapters
  sites/                  Separate Worker serving published static websites
  containers/             Pinned CheckContainer Docker image (check server and check toolchains)
  migrations/             Forward-only D1 discovery migrations
  wrangler*.jsonc         Cloudflare deployment configuration
shared/                   Provider contracts shared with TypeScript
xtask/                    Setup, checks, builds and deployment commands
tests/                    Workers and runtime integration tests
fixtures/                 Small source repositories for tests and demonstrations
docs/                     Architecture, operations and verification
context/                  Original design material
tools/                    Video production and public-source export utilities
```

Workspace manifests, lockfiles and the pinned toolchain stay at the root. Generated builds,
credentials, local state and diagnostic exports are ignored by Git.

## Application boundaries

| Layer | Responsibility | Entry points |
|---|---|---|
| Browser | Accounts, provider connections, run configuration, previews, diffs, decisions, graph and history | [App](../frontend/src/App.tsx), [repository state](../frontend/src/hooks/useRepository.ts) |
| Rust contracts | Typed context, provider descriptors, agent limits, source and evaluation validation | [yoneda-core](../backend/crates/yoneda-core/src/lib.rs) |
| Rust application | Run creation, scheduling, leases, context, capture results, verification, decisions and publication state | [yoneda-app](../backend/crates/yoneda-app/src/lib.rs), [command dispatch](../backend/crates/yoneda-app/src/commands/mod.rs) |
| Cloudflare binding adapter | Implements the storage interface and bridges SDK operations | [yoneda-cloudflare](../backend/crates/yoneda-cloudflare/src/lib.rs) |
| Rust Durable Objects | Repository authority, workspace authority, recovery alarms and live notifications | [yoneda-worker](../backend/crates/yoneda-worker/src/lib.rs) |
| Worker transport | Authentication, HTTP routes, remote MCP, platform API calls, container lifecycle and credential injection | [Worker entrypoint](../cloudflare/worker/index.ts), [routes](../cloudflare/worker/routes.ts) |
| Check executor | Axum `check-server`: runs one platform check's argv on the exact commit's files as an unprivileged user without network, returning bounded evidence | [yoneda-runtime](../backend/crates/yoneda-runtime/src/lib.rs) |

The browser submits commands and displays recorded state. Rust owns authoritative repository
transitions. The application uses the same commands with native SQLite in local tests and
Durable Object SQLite in Cloudflare. TypeScript connects Cloudflare SDK capabilities,
authentication and provider protocols to those commands.

Repository discovery also returns the authenticated account identity. The header displays the
personal username or an explicit Administrator label and provides sign-out. Anonymous visitors
can open username/password sign-in directly; administrator token access remains a separate flow.

## Cloudflare service architecture

```mermaid
flowchart TD
    Browser["Browser"] --> Worker["Platform Worker"]
    LocalAgent["Local agents: scoped MCP"] --> Worker

    Worker --> Workspace["Workspace DO: accounts, connections, access"]
    Worker --> Repo["Repository DO: authoritative state and graph"]
    Worker --> Live["Live DO: WebSocket notifications"]
    Workspace --> Setup["Background project setup via agent queue"]
    Setup --> Platform
    Setup --> Repo
    Setup --> Workspace

    Repo --> Outbox["Transactional outbox and recovery alarms"]
    Outbox --> Queues["Agent, capture and evaluate queues; DLQ"]
    Outbox --> D1["D1: repository discovery index"]
    Outbox --> Live

    Queues --> Sandbox["Sandbox DO: one sandbox per attempt, stock coding CLI"]
    Sandbox --> Egress["Sandbox egress: provider key and project token"]
    Egress --> Providers["External model APIs"]
    Egress --> Platform["Source platform public API: one repository per project"]
    Worker --> Platform
    Worker --> R2["R2: content-addressed objects and static assets"]
    Sandbox --> Repo

    Visitors["Website visitors"] --> Sites["Separate Sites Worker"]
    Sites --> R2
    Sites --> Worker
    AppVisitors["App users and reviewers"] --> Apps["Isolated Apps Worker"]
    Apps --> Loader["Worker Loader: checked application module"]
    Apps --> AppState["AppRunner DO: per-app SQLite"]
    Apps --> Worker
    AppState --> R2
    AppState --> Loader
```

The platform Worker (`yonedarepo-dev`, served at `yonedarepo.com` and `www.yonedarepo.com`)
serves the browser assets and handles `/api`, `/mcp` and the scoped source APIs. Its
`SELF` service binding calls back into the same Worker and its `APPS` binding reaches the Apps
Worker. The Sites Worker (`yonedarepo-sites-dev`) serves published static output on its own
`workers.dev` origin and reads the verified site pointer through a `PLATFORM` service binding.
The Apps Worker (`yonedarepo-apps-dev`) serves checked apps on `apps.yonedarepo.com` and
`*.yonedarepo.com`, also through a `PLATFORM` binding.

| Component | Current role |
|---|---|
| Workspace DO (`WorkspaceAuthority`) | Accounts, hashed sessions, recovery, encrypted provider connections, access grants, project setup leases/stages, durable dispatch intent and workspace allowances. |
| Repository DO (`RepositoryAuthority`) | Runs, executions, jobs, graph nodes/edges, evaluations, decisions, logical HEAD and publication state. SQLite is authoritative. |
| Live DO (`LiveRoom`) | Hibernating WebSocket connections and payload-free refresh signals. Clients reauthenticate when fetching data. |
| Sandbox DO (`AgentSandbox`) | One Cloudflare Sandbox per agent attempt: it runs a stock coding CLI on a clone of the platform repository and pushes to the attempt's own `attempts/<run>/<n>` branch. |
| Queues | Separate dispatch queues for agent, capture and evaluate work. The agent queue also carries `provision` (project setup) jobs, which start no model or container. All three consumers route exhausted retries to a dead-letter queue, which currently has no consumer; durable recovery comes from outbox and alarm retries. |
| Containers | `CheckContainer` runs the platform's checks in the check-server image (sh, git, Python, Node/npm with TypeScript, Rust); agent attempts run in `AgentSandbox` sandboxes. Containers never publish. |
| Source platform | Each project's source is one platform repository reached only through its public `/api/v1`: the agent layer commits candidates onto its own branches with a read/write/check token sealed in the workspace, and only the owner's own session reviews and lands. Artifacts holds only the operator-published starter templates. |
| R2 | Immutable context objects, workspace snapshots, transcripts, verification evidence and static asset manifests. |
| D1 | Rebuildable repository discovery projection. It does not authorize selection or publication. |
| Sites Worker | `yonedarepo-sites-dev` on `workers.dev`. Serves checked static assets after the owner's landing is read back. |
| Apps Worker | `yonedarepo-apps-dev` on `apps.yonedarepo.com` and `*.yonedarepo.com`. Authorizes exact checked previews or the canonical published app through a platform service binding. Each app gets a distinct host; platform cookies are stripped. |
| Worker Loader and AppRunner | Load the checked JS/TS application bundle with outbound network disabled and a managed SQLite capability. Preview and published data are separate. Additive schema migration preserves application data across revisions. |
| Observability | Structured operational Worker/container logs. Safe owner-visible execution timelines also persist in Repository DO SQLite. |

There is no separate Task DO. Runs and jobs live inside the Repository DO. Scheduling uses a
custom Rust state machine, transactional outbox, queues, leases and recovery alarms.

## State and recovery

A repository is the unit of serialization. State, graph changes, ordered events and pending
outbox work commit in one synchronous transaction, without network I/O. Outbox delivery then
dispatches jobs, updates D1 and notifies the Live DO. Alarms recover expired leases and retry
pending delivery.

Queue delivery can repeat. Each active attempt has a server-derived identity and epoch;
callbacks and capability brokers check that epoch before accepting work. Cancellation and
expiry fence the attempt and stop its container.

Durable Object SQL migrations live beside `yoneda-app`. Cloudflare class migrations remain in
Wrangler configuration, and D1 migrations live in `cloudflare/migrations`. These are separate
migration histories with stable resource identities.

## Development workflow

Agent attempts run only in Cloudflare Sandboxes (`sandbox-cli-v1`); `start_run` refuses any other
transport with `SANDBOX_REQUIRED`. The earlier lazy-source transport, with its per-attempt source
workspace authority and harness container, was retired: a Durable Object class migration deleted
both classes, and the native supervisor, harnesses, stdio MCP, source capture and the ledger's
source-binding, broker (heartbeat, model reservation, transcript) and harness resolver operations
are gone. Their old tables stay (no DROP migration). A sandbox's pushed commit becomes its
candidate, and a fresh check sandbox checks that exact commit. Refresh is a server-side platform
merge that retains both parents; a conflicting merge yields a workspace commit for a sandbox
resolver. Resolving a conflict always starts a sandbox resolver run; a deployment without
sandboxes refuses with `SANDBOX_REQUIRED`. Human selection and publication remain separate.

Signup and login create an opaque session backed by Workspace DO SQLite. Project creation
reserves a stable ID there and, in the owner's own request, creates the project's platform
repository from a starter template (or a public Git import) and binds its agent token; the
reviewer and campaign operator flows create it for the named workspace. Background setup then
initializes the ledger from the platform's `main` and the request returns promptly. A Workspace DO
alarm retains dispatch intent and retries queue sends, pending imports and expired claims,
even when the browser is closed or a queue acknowledgment is lost. Idle workspaces stop their
alarm. Browser polling reads recorded stages without starting parallel imports.
Setup claims have a
two-minute lease and epoch; an attempt has a 90-second watchdog, and repeated pending work
stops after ten minutes. Failed setup can retry with the same repository identity.

Accounts accept a username or practical ASCII email as the registered identifier, trimmed and
case-insensitive. Email dots and plus tags are preserved. Encoded cookie/MCP segments prevent
email punctuation from becoming protocol separators; legacy username sessions and grants keep
their original format. The Rust core owns validation and shared contract cases check browser
and Worker parity. Existing usernames do not acquire an email alias automatically. Email
ownership verification and email-based password reset are not implemented; recovery uses the
one-time saved code.

Imports resolve the public Git remote's advertised HEAD and pass its branch to the platform's
durable import. Setup waits for the platform's `main`; empty or unsupported source produces an
actionable error.
The UI displays elapsed time, stage, errors and retry controls. Browser API requests have a
20-second timeout; mutations are not automatically repeated after an uncertain response.
Initial setup events go to
Cloudflare Workers Logs without passwords, credentials or source contents.

The comparison flow is below. [Build together](build-together.md) starts with brief-driven
read-only planning on the first selected connection, or an optional manual plan. Its scoped
proposal is an agent assertion; trusted unchanged-source completion and ledger validation freeze
the task DAG before work starts. One to six selected agents can share worker and integrator roles.
Disjoint specialist write scopes, captured handoffs and deterministic Rust source assembly apply.
Only its final integration receives independent evaluation and owner publication; intermediate
source never becomes a selectable candidate. Autonomous approvals allow a coordinator to amend
the DAG, create tasks, send durable peer messages and repair failed integration within the
original finite approval. Two repair rounds share the same execution and spend caps; a
separately approved one-shot Opus escalation is available only after a cheaper repair fails.
Contradictory intent can pause work for one focused owner answer. Migration 13 stores working
branches, peer messages, delivery receipts and intent questions; migrations remain append-only.

1. The owner approves a brief, source base, context, agent roster and model limits.
2. In comparison mode, agents work independently from the same frozen base and publish typed context through MCP.
3. A separate capture job validates regular files and commits them through the platform API onto the attempt's own branch.
4. A clean evaluator checks the exact captured revision against the approved policy.
5. New two-builder comparisons wait for both terminal results, then schedule a separate read-only
   reviewer. Its immutable manifest binds intent, prior context, both exact revisions, diffs and
   independent checks. Submission is only an agent assertion until trusted unchanged-source
   completion validates the current epoch. The ledger then selects an eligible working result,
   requests a repair of the more promising alternative, or records that attention is needed.
   At most two repair rounds require fresh capture, evaluation and review. Each logical review
   round has 12 model requests shared across retries. The approval has at most seven logical
   executions; all stages remain inside the approved run and workspace funding bounds.
6. The owner can override the checked selection with a reason and separately approve publication.
   The human decision stores the exact selection and a graph link to the immutable agent review,
   keeping reviewer rationale, override reason and publication rationale distinct.
7. The ledger reserves the publication and records the `yoneda-checks` platform check; the
   owner's own session approves and lands the exact commit (`fast_forward_only`, so a moved
   `main` is refused, never merged; break-glass when checks were overridden). The ledger then
   reads the platform back, and only that readback advances the static site or checked app pointer.
8. Later updates carry forward the published approach, decision and selected context for review.

Runs accept one to six initial agents. Optional delegation allows up to 12 total agents through
two delegation levels. Children inherit approved provider, model, source and context; each
produces an independently captured and evaluated candidate. Agent membership is editable
before run approval and frozen afterward.

`continuation_of` connects a new update to the decision at the current published commit.
Restarting a run creates a new approved attempt while retaining the earlier evidence.
Selection, the owner's platform landing and hosted site state remain separately recorded.
Checked team working branches advance automatically under a compare-and-swap guard. Compare
checks alone never promote a candidate: selection requires the completed read-only review or a
guarded owner choice. Older one-to-six-builder runs retain manual selection; existing two-builder
runs can additionally approve review plus bounded repairs without restarting their builders or
resetting original charges. This supplemental approval freezes current policy and its own budget
segment while retaining the original run policy and counters unchanged. Subsequent
feature and bug runs can build on that unpublished checked revision and receive a frozen,
bounded packet of ranked prior intent and evidence. Human approval still controls canonical
publication. A late result from a superseded team plan cannot advance the working branch.

## Context graph and agent access

The graph resides in Repository DO SQLite as typed nodes and edges. It joins intent, runs,
agent assertions, artifacts, executions, candidates, evaluations, decisions and source
revisions. Agent assertions remain distinct from independent checks and human decisions.

Human review starts with the working app, requested behaviors, checks and readable rationale.
Multi-file changes and the React Flow graph are optional detail. Peer conversations show actual
message bodies and platform delivery/acknowledgment receipts; those receipts do not prove
understanding. Historical reads and context retrieval use bounded, stable-watermark pages.
Historical queries are anchored to a specific source revision and path; graph traversal is bounded.

Hosted agents are stock CLIs in sandboxes. External agents use Streamable HTTP MCP and
revocable repository-scoped grants: `attempt_read` and `attempt_commit` read and commit files on
the attempt's own platform branch through the Worker, which never returns a platform credential.
On submission a trusted Worker capture rebuilds the bound tree as one fresh commit on the frozen
base, which then enters the same evaluation pipeline, with owner selection required for publication.

## Providers and credentials

The single provider registry lives in
[yoneda-core/src/providers.json](../backend/crates/yoneda-core/src/providers.json) and is
consumed by Rust, the Worker and browser through `shared/providers.ts`. Current providers are
OpenAI/Codex, Anthropic/Claude, MiMo, ZAI and Gemini. Harnesses are Codex, Claude Code and Gemini
CLI; a provider's protocol selects the compatible harness and egress adapter.

Personal provider keys are encrypted for their workspace. Operator keys use Cloudflare Secrets
Store bindings for Codex, Claude, MiMo and ZAI. Gemini is registered as a provider but has no
operator key bound; Gemini runs need a personal key. The Worker resolves and injects credentials into allowlisted upstream requests;
agent processes do not receive the provider keys. Saved connections determine billing route,
model and region. Request and dollar caps are optional for new runs; execution duration,
response bounds, provider quotas and the Claude workspace allowance still apply.

## Local development and deployment

`cargo xtask` coordinates setup, checks, native/Wasm and browser builds, local servers and
deployment. Local integration tests use real workerd Durable Objects, SQLite and R2 without
paid inference. The check server's binary is built and tested inside the pinned Linux
CheckContainer image.

See [README setup and deployment](../README.md), [runbook](runbook.md),
[provider configuration](providers.md), [MCP guide](remote-mcp.md) and
[logging](logging.md) for operational details.

## What differentiates the platform

Parallel isolated branches are an expected agent-tool capability. YonedaRepo's distinguishing
design is a durable evidence chain: intent and agent assertions, trusted source capture,
independent exact-revision checks, explicit human decisions and file-level provenance. Later
agents receive a frozen record of why the current checked code exists, rather than only source
or a chat transcript. Coordination and bounded repair use the same ledger and approval.

This is a design distinction, not a claim of unique invention or proven coding improvement.
Controlled source-only/plain-notes/graph maintenance chains measure context usefulness
separately. The application profile supports JS/TS UI/API/SQLite with constrained capabilities;
arbitrary networked backends and large-scale throughput are not claimed. Hosted run and
deployment evidence must be checked independently from source and local tests.
