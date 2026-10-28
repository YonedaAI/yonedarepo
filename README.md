# YonedaRepo — Source Control for Agents

A Git-compatible source platform built for agents and other API clients. Clients never clone: they read, commit, merge and land through an HTTP API and MCP, and every write becomes a server-side commit with real Git object ids. It runs entirely on Cloudflare.

[Try it at yonedarepo.com](https://yonedarepo.com/) · [Submission](docs/submission.md) · [Architecture](docs/current-state-architecture.md) · [Release evidence](docs/release-evidence.md)

![Reviewing an exact captured revision before publication](docs/images/selection-review.png)

## What the platform does

- **Git semantics on the server.** Commits, trees, branches, merge (three-way, matching `git merge-file` on a 300-case differential test), revert, cherry-pick, diff, log, blame and bisect. Objects live in Cloudflare Artifacts, so any Git client can clone the result.
- **A transaction log, like a Delta Lake table.** Each repository's Durable Object keeps an append-only log with checkpoints. Reads take `at=` a version, time or commit; refs move by compare-and-swap.
- **Concurrency without a merge lock.** Changes declare what they read (paths or symbols such as `src/lib.rs#Policy::backoff`). A stale read conflicts; edits to different parts of one file merge; landings on a busy branch are batched into one merge commit. Failed post-land checks propose a repair commit instead of rewriting history.
- **Compute next to the data.** Code search that re-indexes only changed directories, blame and path history, symbols and symbol edits that reject stale handles, contracts derived from signatures and doc comments, an agent view (a symbol with its contract, callers and callees) and a human view (a generated subsystem overview), and a work planner that groups reference cycles and schedules only independent work in parallel.
- **Review and checks.** Checks run in Containers on the exact commit. Comment-, docs- and formatting-only changes can be auto-approved; anything unparseable needs a human. Gates apply to protected refs only (`main`, `release`, `release/*`); unprotected refs land with `write`, like a branch move.
- **Scoped access.** Tokens can be limited to directories, enforced on every read, search and cache path. A human-only break-glass path can land, revert or pause automation when checks or agents are down; it is never exposed over MCP.

The agent features below (runs, teams, compare) are a separate layer that uses the platform like any other client.

## Try it

- Sign up, save the recovery code, connect your own provider key under **Connect Agents**, add a repository and choose **Start a Run**.
- **Read-only CLI** (Node 24, starts no inference): `node tools/reviewer.mjs --checked`. It prompts for the key without echoing it.
- Publication is always a separate human decision. Opening forms or sample briefs starts no work.

## The agent layer: how a run works

- **Start a Run** with one to six agents. Each runs a stock coding CLI in its own sandbox on the same base; their results are captured and independently checked, and you choose which one to publish, with a reason.
- **Build together** splits the work into tasks you write: one sandboxed agent per task, each landing on the run's team branch, whose merge is the single checked result.
- Runs are bounded per model group (requests, output and execution time) within the shared workspace allowance.
- Providers: OpenAI/Codex, Anthropic/Claude, ZAI (GLM), MiMo and Google/Gemini. Keys are sealed per workspace and injected by the Worker; agents never hold them. See [providers](docs/providers.md).
- Your own agent can join through scoped MCP and Git. See [the MCP guide](docs/remote-mcp.md).

More: [build together](docs/build-together.md) · [website workflow](docs/website-workflow.md) · [context usage](docs/context-usage.md) · [logging](docs/logging.md)

## Architecture

Rust owns the domain rules and durable state; TypeScript is a thin adapter for Cloudflare SDK features. On Cloudflare:

- **Durable Objects** (Rust → Wasm, SQLite): `SourceRepository` is the platform's authority (transaction log, refs, approvals, grants). A per-repository push queue batches writes to Artifacts, which accepts one push per repository at a time.
- **Artifacts** stores the Git objects. The server pushes small packs to hidden refs and reads each commit back before recording it; branch refs are projected afterwards with expected-old leases and drift detection.
- **Workers** serve the API, MCP and web UI, and run stateless Rust compute (diff, merge, search, symbols) next to a tiered object cache: Cache API, then R2, then Artifacts.
- **Containers** run platform checks; **Queues** and **Workflows** run derived-data jobs, ref projection and imports; **D1** is a rebuildable repository index.
- The agent layer (Repository, Workspace and Source-view objects, harness Containers, provider brokers) is a separate set of crates and routes. The platform Worker (`cloudflare/wrangler.{dev,prod}-platform.jsonc`, generated from `infra/envs/`) runs without it.

## Run locally

Requires the pinned Rust toolchain (1.99.1), Node 24.22+, pnpm 12, Docker and `worker-build` 0.8.7.

```sh
cargo install worker-build --version 0.8.7 --locked
cargo xtask doctor
cargo xtask setup
cargo xtask check   # full local gate, no provider keys or paid inference
cargo xtask dev     # http://localhost:8787 (sites on :8788)
```

For browser hot reload, keep Wrangler running and run `pnpm --dir frontend dev`.

## Deploy to your own Cloudflare account

- **Requirements:** Workers Paid, Containers, R2, Queues and [Artifacts access](https://developers.cloudflare.com/artifacts/get-started/workers/), plus a `workers.dev` subdomain.
- **Sign in:** `cargo xtask setup`, then `pnpm exec wrangler login`.
- **Create D1 once** with a minimal config that can't target our account:

  ```sh
  mkdir -p .local/bootstrap
  echo '{"account_id":"YOUR_ACCOUNT_ID","name":"my-yoneda","compatibility_date":"2026-10-07"}' > .local/bootstrap/wrangler.json
  pnpm exec wrangler d1 create my-yoneda-index --config .local/bootstrap/wrangler.json
  ```

- **Configure:**

  ```sh
  cargo xtask cloudflare-configure --name my-yoneda --account-id YOUR_ACCOUNT_ID \
    --subdomain YOUR_SUBDOMAIN --namespace my-yoneda --database-id YOUR_D1_UUID
  ```

- **Create the R2 bucket and queues once:**

  ```sh
  C=.local/deploy/my-yoneda/platform.json
  pnpm exec wrangler r2 bucket create my-yoneda-objects --config $C
  for q in dead-letter agent capture evaluate platform; do pnpm exec wrangler queues create my-yoneda-$q --config $C; done
  ```

- **Deploy:** `cargo xtask cloudflare-deploy --name my-yoneda` (add `--dry-run` first). It builds, migrates D1, deploys the platform, container and sites Workers, and checks health. It starts no paid inference.
- **Run locally against your account:** `cargo xtask dev --name my-yoneda`.
- **Back up** `.local/deploy/my-yoneda/owner-token` and `vault-key` privately. Losing the vault key makes stored provider keys unreadable.

Details: [runbook](docs/runbook.md) · [public metadata and custom domains](docs/public-metadata.md)

## Repository

```text
frontend/            Browser app (React 19, React Flow)
backend/crates/
  yoneda-core/       Shared contracts: Git object model, transaction log, merge and validation
  yoneda-agents-core/ Agent-layer contracts: runs, teams, providers, budgets, evaluation
  yoneda-store/      SQL store trait and the native SQLite store
  yoneda-platform/   Source platform authority, migrations and stateless compute
  yoneda-app/        Agent-layer commands, graph and DO migrations
  yoneda-cloudflare/ Rust binding interoperability
  yoneda-worker/     Rust Durable Objects
  yoneda-runtime/    Check server for the CheckContainer
cloudflare/          Worker adapters, sites, container image, D1 migrations, Wrangler config
shared/              Contracts shared with TypeScript
xtask/               Developer and deployment commands
tests/               Cross-boundary workerd and runtime tests
fixtures/            Small demo repositories
docs/                Architecture, operations and verification evidence
```

[Engineering standards](AGENTS.md) · [Implementation ledger](docs/progress.md) · Apache-2.0
