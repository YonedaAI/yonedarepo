# YonedaRepo

A Context Graph platform for the agentic era. Explore parallel implementations, evaluate captured source independently, and preserve the intent, assumptions, alternatives and human decision behind a published revision.

Rust owns the domain, transactional ledger, native agent supervisor, MCP server, source capture and verifier. Cloudflare hosts the Worker, Durable Objects, Queues, R2, D1, Containers and Artifacts. React 19 and React Flow provide the browser. A small TypeScript adapter connects SDK capabilities absent from workers-rs.

## Get running

Requires the pinned Rust toolchain, Node 24, pnpm 11, Docker, and `worker-build` 0.8.7:

```sh
cargo install worker-build --version 0.8.7 --locked
cargo xtask doctor
cargo xtask setup
cargo xtask check
cargo xtask dev
```

Open `http://localhost:8787`. Use the owner connection with the token in `.local/owner-token`; this file is ignored and is never printed by setup. Cloudflare Access can replace the token for deployed browser sessions. The local test gate uses workerd and SQLite without paid inference.

To work on the browser with hot reload, keep Wrangler running and run `pnpm --dir web dev` in another terminal. The Vite server proxies API traffic to Wrangler.

## Run real agents on Cloudflare

The committed development configuration targets the project account and namespace. Read [the runbook](docs/runbook.md) before using a different account. Provider secrets are resolved in Worker egress handlers from Secrets Store bindings `Codex` and `Claude`; they are not copied to containers.

```sh
cargo xtask deploy
cargo xtask seed-demo --url https://YOUR-WORKER.workers.dev
cargo xtask demo --url https://YOUR-WORKER.workers.dev
```

Testing defaults are Codex `gpt-5.6-luna` and Claude `claude-sonnet-4-6`. The browser shows the research step, three parallel approaches, exact captured commits and independent checks. Review code and record a rationale to select a candidate. Selection and verified canonical publication have distinct states.

After human selection and publication:

```sh
cargo xtask verify-live --url https://YOUR-WORKER.workers.dev
```

This verifies recorded live evidence and writes an ignored artifact. It does not synthesize agent results or automatically accept code. Simulated incident observations are explicitly labelled in the browser.

## Repository

```text
crates/
  yoneda-core/        Contracts, evidence and policy validation
  yoneda-app/         Transactional commands, graph and versioned DO migrations
  yoneda-cloudflare/  Rust SDK interoperability
  yoneda-worker/      Rust Repo and Live Durable Objects
  yoneda-runtime/     Native supervisor, MCP, harnesses, capture and evaluation
worker/              Focused SDK, transport and authentication adapters
web/src/             Browser features, components, hooks and feature styles
containers/          Pinned native runtime image
migrations/          Forward-only D1 discovery migrations
fixtures/            Small source repositories used in demonstrations
tests/workers/       Real workerd integration tests without inference
xtask/               Reproducible developer commands
docs/                Architecture, runbook and implementation evidence
context/             Original design material
```

[Architecture](docs/architecture.md) · [Runbook](docs/runbook.md) · [Engineering standards](AGENTS.md) · [Implementation evidence](docs/progress.md)

Apache-2.0. This is the bounded MVP described in [the implementation contract](docs/implementation-plan.md); generic task DAGs, enterprise tenancy and automatic semantic merges are deferred.
