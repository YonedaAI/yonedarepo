# Logging and retained execution history

YonedaRepo uses Rust `tracing` 0.1.44 and `tracing-subscriber` 0.3.23, emitting newline-delimited JSON to stderr. The executable installs the subscriber once; the library only emits events. Async attempts use `Instrument`, so spans remain correct across awaits. Only `yoneda_runtime` targets are enabled, including at debug level: dependency HTTP diagnostics cannot expose headers. `YONEDA_LOG_LEVEL` accepts a level such as `info` or `debug` and defaults to `info`. Scoped MCP stdout remains a protocol stream.

This follows the official [tracing subscriber guidance](https://docs.rs/tracing-subscriber/latest/tracing_subscriber/fmt/index.html) and [async span guidance](https://docs.rs/tracing/latest/tracing/struct.Span.html). No log server, file rotation daemon or browser-specific Wasm logging library is required.

## Cloudflare operational logs

The TypeScript egress and transport adapters emit JSON objects with allowlisted fields. Search by `event`, `repo_id`, `run_id`, `execution_id`, `job_id`, `epoch`, `provider`, `model`, `billing_source`, `region`, `request_number`, `http_status`, `stage` and `error_code`. Rust container lifecycle records use attempt spans containing the job, execution, run and epoch.

Repository onboarding emits `project.setup_progress`, `project.setup_waiting`, `project.setup_ready`, `project.setup_failed` and `project.dispatch_failed`. Filter by `repo_id` to follow creation/import, source validation and initialization. These records contain stages, epochs, elapsed time and classified errors; passwords, Git capabilities, source contents and raw SDK exception text are excluded. The Workspace DO retains setup status and dispatch intent separately from log retention, so losing operational logs does not strand setup.

In Cloudflare, open **Workers & Pages → your Worker → Observability**. `observability.enabled` is already true in the development and generated deployment configs and applies to container logs. Cloudflare recommends structured JSON because its fields are indexed. Operational retention is currently three days on Workers Free and seven days on Workers Paid; container logs are retained seven days. See [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and [Container logs](https://developers.cloudflare.com/containers/faq/#how-do-container-logs-work).

To inspect live operational output locally or remotely:

```sh
pnpm exec wrangler tail yonedarepo-dev --format json
```

Wrangler's invocation envelope can contain request metadata. Do not share raw tail exports or enable body/header debug logging. Application records exclude API keys, authorization headers, supervisor tokens, prompts, source files, provider response bodies and raw exception strings.

## Owner-visible retained logs

Each approach has **View logs**. Its request timeline distinguishes an execution claim, a request sent upstream, received response headers, a request blocked locally, transport failure and completion/failure callbacks. Status, HTTP code, duration and error classification are retained. Duration on a response record measures time to response headers, not completion of a streamed generation. Refresh and pagination are explicit; no background polling loop is added.

The Repo DO stores these observations in an indexed SQLite `execution_logs` table, using forward-only application migration `0006`. Cursor pages contain at most 100 entries. Identity and routing are derived from an active, fenced attempt; supplied identity fields and arbitrary messages are discarded. Event IDs make repeated writes idempotent. Owner reads use the same workspace authorization as repository access; agents cannot fetch this endpoint.

Log writes are best effort and cannot fail an otherwise successful model call. A failed write emits `logs.persist_failed` to Cloudflare. They do not produce graph events, D1 discovery writes or Live DO notifications. Repository diagnostics have no automatic expiry yet and remain in its DO storage until that storage is removed; monitor storage consumption. Cloudflare's operational retention does not expire these rows. Existing content-addressed R2 transcripts remain immutable owner-authorized evidence, separate from the safe timeline; they can contain agent conversation content and must not be copied into operational logs.

Historical runs show an honest empty timeline because request telemetry cannot be reconstructed. **Explain failure** still reads their recorded terminal outcome and maps only supported statuses or exact platform errors to safe guidance.

`EXECUTION_TIMEOUT` identifies the approved wall-time limit, separately from provider failures. The browser also recognizes the exact historical `Execution deadline exceeded` outcome. A timeout can follow successful HTTP 200 model responses and may have no harness transcript because the process never finished; its retained request timeline is still available. Review **Restart run → Minutes per execution** (1–30 minutes, default 10). Provider-settings recovery is shown only for diagnosed provider errors.

## Deployment and local checks

Deploy the Worker bundle containing the new Rust ledger and browser before expecting timeline reads. Existing DOs apply migration 0006 on their next command; no D1 migration, DO class rename, secret replacement or manual SQL is needed. Deploy the rebuilt container for native Rust JSON lifecycle logs. Keep both earlier SQL migrations and Cloudflare DO class migration history intact.

Worker and DO code updates propagate separately for a short period. New commands can briefly receive an unknown-operation response from an older DO. Confirm the new commands against existing objects before declaring the rollout ready; preserve stored data and stable DO identities. See [Cloudflare code update guidance](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).

Ledger and runtime health advertise their maximum supported execution time. Longer approvals fail closed against older deployments. New jobs separate their dispatch deadline, startup allowance and approved execution duration. The container watchdog renews SDK idle activity only after confirming the attempt remains valid, so background executions can continue beyond the twelve-minute idle setting. See [Cloudflare activity renewal](https://developers.cloudflare.com/containers/api/container-class/#renewactivitytimeout).

`cargo xtask check` requires no paid inference. Logging checks cover v5 upgrade/repeat migration, idempotency, cursor boundaries, attempt fencing, real DO eviction, workspace isolation, private-field exclusion and sink failure. A live provider build is a separate acceptance step.
