# YonedaRepo — Agent-First Repository: submission

An API-first, Git-like transactional model where agents fetch only what they need, coordinate changes, and preserve context.

Entry for Cloudflare's [Build the Next-Gen Git Platform](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) competition. Source: [MagnetonIO/yonedarepo](https://github.com/MagnetonIO/yonedarepo) (Apache-2.0).

## What it is

Git was built for people who each keep a full copy of a repository and sync occasionally. Agents are always online, there can be many at once, and their claims about their own work cannot be trusted by default. YonedaRepo treats the repository as an agent-first, API-first transactional service.

| Principle | What the platform does today |
|---|---|
| **Fetch only what you need** | Each agent gets a frozen, bounded packet of prior context, plus either an isolated Git fork or a lazy server-side source view that loads files on demand. No agent clone is needed on the lazy path. |
| **Coordinate changes** | One transactional ledger per repository holds the planned task graph, durable peer messages and working branches that advance only when the expected version still matches. Stale or conflicting results wake a coordinator that reconciles them and obtains fresh checks. |
| **Preserve context** | Intent, agent claims, independent checks and human decisions link to exact revisions in a typed graph. The next run inherits that history instead of starting cold. |
| **Claims are not authority** | Trusted capture builds fresh Git objects. A clean evaluator checks that exact revision against a protected test bundle. A human decides what ships. |

This answers the competition's questions directly: what others are working on (one shared ledger), what happens on conflict (scoped reconciliation and recheck), how to review agent output (one checked result with its reasons) and how to track why (file-level provenance).

## How a judge tries it

1. Open [yonedarepo.com](https://yonedarepo.com/) and choose **Have a reviewer access key?** Enter the privately supplied key. No signup or provider key is needed. The key is never stored in this repository.
2. Start the **guided task-board demo**. It creates a fresh project from an immutable starter and runs four stages:

   | Stage | What to look for |
   |---|---|
   | 1. Build together | A planner defines a shared API contract; at least two specialists work concurrently; their captured contributions form one independently checked result. |
   | 2. Continue from context | A new run adds a feature by opening and citing the earlier design record instead of being told it again. |
   | 3. Reconcile concurrent changes | Two runs start from the same checked base and both edit the same function; the coordinator resolves the actual overlap and obtains fresh combined checks. |
   | 4. Review and publish | One final result with what changed, why, checks and remaining issues. Publication is a separate human approval; partial stages cannot publish. |

3. Or choose **Start a Run**, describe an app, feature or bug fix, and leave the first agent on **Auto**. The planner selects the team and returns one checked result.
4. Read-only CLI from this source with Node 24 (prompts for the key without echoing it; starts no inference):

   ```sh
   node tools/reviewer.mjs --checked
   ```

   `--key-file /path/to/access.json` and `--no-open` are supported.

Reviewer work draws on a configurable shared workspace allowance (currently $100), counted conservatively with retained spending. Sample briefs only prefill a form; selecting one is not evidence that the behavior occurred.

## What is verified today — 2026-10-14

All hosted items were observed on 2026-10-14 against `yonedarepo.com`.

| Boundary | Result |
|---|---|
| Deployment | Platform Worker on implementation revision `fa07681`; runtime image R17, container application version 37, **0 failed instances**. |
| Guided project creation | A fresh guided project kept its guided marker and forked the immutable starter `ca7c0f2`. This fixes the earlier blocker where a guided project lost its marker and fell back to the ordinary starter. |
| Lazy-source build stage (hosted) | On the lazy-source API transport, a guided build step integrated two specialists' captured contributions and passed independent checks at revision `73aeec4`. This followed fixes for directory listing, upload verification, per-file receipts, integration-manifest digest and the coordinator's read-only source. |
| Local gates | `yoneda-app` 403 tests; `yoneda-runtime` lib 132 + `source_http` 12 + `source_write_receipt` 5; focused Workers suites 140–162 tests; frontend 311 tests; Clippy and rustfmt clean. These are focused slices, not one monolithic `cargo xtask check` run. |
| Public source | Public CI green on export `22481c1`. |

**Not yet verified (TODO — lead to fill in):**

- TODO: full guided canary on the **Git-native** transport — context continuation, conflict reconciliation and final checks (run ID, revisions, check results).
- TODO: full guided canary on the **lazy-source** transport — context continuation, conflict reconciliation and final checks (run ID, revisions, check results).
- TODO: demo video link and SHA-256 for the current guided UI.

Until those entries are filled in, only the build stage above is hosted evidence for the guided demo. Earlier dated results are in [release evidence](release-evidence.md) and the [implementation ledger](progress.md).

## Architecture on Cloudflare

Diagram and component table: [current-state architecture](current-state-architecture.md). Rust owns domain rules, the transactional ledger, the native runtime, MCP, capture and evaluation. TypeScript is the browser and a thin adapter for Cloudflare SDK capabilities absent from workers-rs.

| Cloudflare product | Role |
|---|---|
| Workers | Platform Worker `yonedarepo-dev`: authentication, `/api`, remote MCP, scoped Git and source APIs, queue consumers, and capability brokers that inject credentials so agents never hold them. |
| Durable Objects (Rust → Wasm, SQLite) | `RepositoryAuthority` is the transactional authority: runs, graph, decisions, logical HEAD, outbox, recovery alarms. `WorkspaceAuthority` holds accounts, sealed provider keys and allowances. `SourceWorkspaceAuthority` serves per-attempt lazy source views with compare-and-swap writes. `LiveRoom` pushes refresh signals over WebSockets. |
| Containers | `ExecutionContainer` runs the pinned native Rust runtime: agent harnesses (Codex, Claude Code, Gemini CLI), trusted capture, clean evaluation and publication, each with separate capabilities. Egress goes through Worker brokers. |
| Queues + outbox | Agent, capture, evaluate and publish queues fed by a transactional outbox, plus a dead-letter queue. The agent queue also carries project provisioning and source-index jobs. |
| Artifacts | Canonical Git repositories and per-attempt candidate forks. Publication uses an expected-old-ref lease, ancestry checks and readback. |
| R2 | Immutable evidence, context objects, source blobs and site assets. |
| D1 | Rebuildable repository discovery index; never authorizes selection or publication. |
| Secrets Store | Operator provider keys, resolved only inside the Worker. |
| Sites and Apps Workers | Serve checked output on isolated origins. The Apps Worker uses Worker Loader and an `AppRunner` Durable Object to give each checked app its own sandboxed module and SQLite. |

## Source plane: today vs. target

**Built today.** Agents on the lazy-source transport work without a clone. Linux FUSE presents a working tree backed by scoped source APIs, `SourceWorkspaceAuthority` and R2. Writes are compare-and-swap checked; each attempt seals one diff that trusted capture turns into a Git commit in Artifacts. Git remains the canonical history. The lazy transport is enabled per repository by the operator; other runs use the Git-native transport. Source views are bounded (10,000 files, 100 MiB total, 32 MiB per file).

**Roadmap — not built.** A transactional layer over source, in the spirit of the Delta Lake log on Spark, but for code:

1. An ordered, append-only changeset log in the repository Durable Object as the source of truth, with immutable content-addressed blobs in R2 and Git generated from the log for compatibility.
2. Optimistic concurrency: each agent commits against the snapshot version it read; the log detects path-level conflicts at commit time; only conflicting commits retry or go to the coordinator.
3. Snapshot isolation and time travel: read the repository "as of" any log version, with periodic checkpoints that compact the log.
4. Remove the remaining full copies by sharing blobs across revisions and evaluating and publishing from the log.
5. Ranged writes instead of whole-file rewrites.

None of the roadmap items above are implemented or measured.

## Limits and honest claims

- **Not a Git replacement.** Git stays canonical and compatible. We do not claim equivalence to Scion or any distributed changeset system.
- **No unmeasured scale.** No throughput, monorepo or concurrency-at-scale claim is made beyond the recorded measurements.
- **Receipts are not causal benefit.** Context delivery, opening and citation receipts are revision-bound and queryable; they do not prove that context improved the outcome. An earlier controlled study found no pass advantage for the graph over plain notes.
- **No general semantic merge.** Conflict reconciliation is scoped and freshly checked; it is not universal semantic conflict resolution.
- **Separate gates.** Source implementation, local tests, deployment, hosted runs and human acceptance are recorded separately. An unfamiliar-human rehearsal of the guided demo has not been recorded.

## Differentiation

Agent sessions and searchable decisions exist in [Entire](https://docs.entire.io/); dependency-aware planning and isolated Git workspaces appear in [CAID research](https://arxiv.org/abs/2603.21489v2). YonedaRepo's distinction is the combination: a server-side transactional ledger for coordination, agent claims kept separate from trusted capture and independent checks, bounded approvals, and human decisions, all linked to exact revisions. This is a product-design claim, not proof of unique invention or an algorithmic advantage.

## Earlier recorded evidence (dated)

| Question | Measured result | Limit |
|---|---|---|
| Concurrent agent work | GLM and Codex specialist harness/transcript markers overlapped 67.477 seconds; both captured revisions contributed to the checked integration. | Marker interval includes completion/teardown/upload, not pure inference time. |
| Recovery and coordination | Eight coordinator MCP operations completed; one guarded repair produced plan revision 2, repair round 1, with both specialist captures retained. | One observed integration recovery, not general semantic-conflict quality. |
| Costs and authority | Original shared GLM and Codex groups each reached 48/48 requests. All 19 recovery reservations settled; the campaign retained $0.528906 of conservative charges. | Not provider invoices; no allowance or model roster was renewed. |
| Features and bug fixes across runs | A six-chain maintenance study completed 18 stages: 16 passed, two failed. Plain notes and graph each passed both full chains; both source-only chains failed the final duplicate-registration case. | Separate maintenance evidence, not a coordinated-team claim. |
| Platform failure behavior | Real bounded capacity deferrals, injected publication-acknowledgement recovery and a disjoint two-parent refresh passed hosted checks without model calls. | Injected fault and small workload; broad scalability is not claimed. |

The October 13 maintenance acceptance was run `run-699e54e0-d070-443c-a0df-9e8272835c5c`, revision `53033856054d10a35f8c967f39b609c30b629732`: a request-key ownership bug fixed using prior run context; six protected tests passed after one automatic repair. The [October 13 walkthrough video](https://github.com/MagnetonIO/yonedarepo/releases/download/reviewer-2026-10-13/yonedarepo-reviewer.mp4) (SHA-256 `494a0888600e3fbab362b76387e0842e99fec653936b19bbd01ecdb745402010`) is an edited walkthrough that predates the guided demo and the Start a Run interface. Full dated history: [release evidence](release-evidence.md), [machine-readable record](release-evidence.json).

The competition application, eligibility and attendance are submitted manually by the owner.
