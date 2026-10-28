# Logging

Where the source platform's operational output goes and how to read it. No log server, file rotation daemon or browser log stream is part of the platform.

## Workers

Every env's Worker configs set `observability.enabled`, so each Worker's logs, exceptions and invocation outcomes are in **Workers & Pages → the Worker → Observability**, searchable by field. Cloudflare recommends structured JSON because its fields are indexed.

The platform Worker names its env's superfan Worker (`yonedarepo-<env>-superfan`, `cloudflare/superfan/`) in `tail_consumers`: superfan receives the platform's tail events (outcomes, logs, exceptions, CPU and wall time) with no API token, reads the GraphQL Analytics API hourly, and keeps its findings in its own ledger behind `GET /findings` and `GET /status` (bearer `SUPERFAN_READ_TOKEN`). It posts nowhere.

To watch live output:

```sh
pnpm exec wrangler tail yonedarepo-dev-platform --format json
```

Wrangler's invocation envelope can contain request metadata. Do not share raw tail exports or enable body or header debug logging. Credentials (tokens, authorization headers, Secrets Store values) never belong in a log line.

## Check containers

`yoneda-runtime check-server`, which runs each check in a `CheckContainer`, uses Rust `tracing` 0.1.44 with `tracing-subscriber` 0.3.23 and writes newline-delimited JSON to stderr (`backend/crates/yoneda-runtime/src/telemetry.rs`). The executable installs the subscriber once; library code only emits events. Container output appears in the platform Worker's Observability with the rest of its logs.
