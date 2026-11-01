# Logging

Where the source platform's operational output goes and how to read it. No log server, file rotation daemon or browser log stream is part of the platform.

## Workers

Every env's Worker configs set `observability.enabled`, so each Worker's logs, exceptions and invocation outcomes are in **Workers & Pages → the Worker → Observability**, searchable by field. Cloudflare recommends structured JSON because its fields are indexed.

The platform Worker names its env's superfan Worker (`yonedarepo-<env>-superfan`, `cloudflare/superfan/`) in `tail_consumers`: superfan receives the platform's tail events (outcomes, logs, exceptions, CPU and wall time) with no API token, reads the GraphQL Analytics API hourly, and keeps its findings in its own ledger behind `GET /findings` and `GET /status` (bearer `SUPERFAN_READ_TOKEN`). On the wide watch (`WATCH_WIDE=on`, dev only for now) the front and managed Workers name it too. It mails the owner and posts nowhere else: [incidents.md](incidents.md) has every alert.

Superfan counts a few log lines by their JSON `event` field (`MARKS`, `NAMING` and `PUSH_RETRY` in `cloudflare/superfan/tail.ts`), so renaming one of those events silently stops its alert. A `NAMING` event's `repo` and `seq` reach the finding, and only if they are shaped as a repository id and a number.

To watch live output:

```sh
pnpm exec wrangler tail yonedarepo-dev-platform --format json
```

Wrangler's invocation envelope can contain request metadata. Do not share raw tail exports or enable body or header debug logging. Credentials (tokens, authorization headers, Secrets Store values) never belong in a log line.

## Log lines

Worker code writes through `cloudflare/worker/log.ts` and nothing else; `tests/runtime/log-discipline.test.mjs` refuses a bare `console.*` in `cloudflare/` (Superfan's notices and dead-man stay bare: what watches the platform must not depend on it). A line is one JSON object with `event` first, because Superfan's tail and the SSH end-to-end test match on that:

```json
{"event":"request.failed","level":"error","request_id":"8f1c2d3e4a5b6c7d-SJC","repo":"r0123…","job":"refs","kind":"platform_project","revision":"abc1234","operation":"GET /api/v1/repos/:repo/log","code":"INTERNAL","status":500,"error":"…"}
```

| Rule | How |
|---|---|
| A line can't fail or slow a request | Synchronous, never awaited, built inside a `try` |
| Nothing unlisted gets in | Keys outside `FIELDS` in `log.ts` are dropped, even from a spread |
| Nothing secret gets in | Every string is scrubbed: bearer tokens, URL credentials, `token=` and the like, session cookies, JWTs, known key prefixes, email addresses, long opaque runs |
| Repository content stays out | Routes are reduced to their shape, and JSON parse errors lose the text V8 quotes. An error message is otherwise kept, up to 500 characters, so a message that quotes a file path shows it |
| A line has a size | 4,000 characters at most; over that, only its identifying fields are written |

With `SPAN_SAMPLE=<N>` on the platform Worker, 1 request in N and every request over 5 seconds also write `request.spans`, after the answer: `operation`, `status`, `total_ms`, and `spans`, the request's `Server-Timing` phases, slowest first, each with `name`, `ms` and `count`. The same request writes one `SITE_EVENTS` point with `blob1 = 'spans'`: index the operation, blobs operation, short revision and `own` for our own traffic, then up to 16 span names; doubles total, status, then each span's milliseconds. Phases stop when the answer's headers go out, so a streamed clone or push shows the walk and not the pack.

Unexpected failures write `request.failed`: every 5xx except those the platform means to give (`OVERLOADED`, `REPO_FULL` and the like, `PLANNED` in `repo-api.ts`), plus `DATABASE`, a failed statement in the authority. That code still answers 400 today.

## The request id

The id is Cloudflare's `cf-ray` where the edge gave one, otherwise a sent `x-request-id` of the right shape, otherwise a fresh UUID. Failure lines always carry it. With `REQUEST_IDS=on` it also goes on every response as `x-request-id`, and error screens show it as the reference.

To follow one failure, search Workers Logs for the id across the platform, front and managed Workers.

| Hop | Does `cf-ray` survive? | How the id travels |
|---|---|---|
| Service binding, same `Request` | Yes, the headers are forwarded | `x-request-id` too, so a request with no ray keeps one id |
| Service binding, new `Request` | No | `x-request-id` |
| Durable Object `fetch` (`durableJson`, `workspace.ts`) | No, a new request | `x-request-id`; Rust reads it for `wasm.panic` and `repo.command_failed` |
| Queue | No, a message has no headers | `request_id` in the `Envelope`, stamped by `carriedQueue` |
| RPC to `CheckContainer` | No | `request_id` in the `CheckJob` |
| Container | No, a new request | `x-request-id`; the runtime and pack builder put it in their lines |

Tested in workerd, where a test sets `cf-ray` itself. That a real edge ray has this shape and survives a real binding is unverified until dev runs it.

The `Envelope` field is optional and consumers read fields by name, so old and new messages and Workers mix during a deploy. A message without it logs under a new UUID; one with a malformed id is treated the same. `REQUEST_IDS` needs no deploy order.

Not carried yet: RPC to `LandCombiner`, whose batches serve many requests (its lines name the repository, and each lander's own failure line has its id); `accountCreated` and `verifyEmail`; the import workflow; the managed Worker's own queue; Git over SSH, where each gateway call gets its own id.

## Panics

`telemetry.rs` installs a hook when a Wasm instance starts, so a fresh instance has it too. A panic writes `wasm.panic` with its source position. The message is kept only when it is a literal in the source, since a formatted one can quote its input. `rustCall` then writes `wasm.trap` with the request id. Inside a Durable Object, the hook takes the id from the request it is serving.

## Browser errors

`AppErrorBoundary` and `window.onerror` post the message and path to `POST /api/client-error` on the front Worker, which writes `client.error` while `CLIENT_ERRORS=on`. It is same-origin, rate limited per address by `AUTH_LIMITER`, and takes at most 2 KB. It always answers 204. The route is reduced to its shape first: `/:owner/:repo/blob`. Scripted browsers are dropped, as with the ping, so a headless browser's error is not logged.

## Containers

`yoneda-runtime check-server`, which runs each check in a `CheckContainer`, uses Rust `tracing` 0.1.44 with `tracing-subscriber` 0.3.23 and writes newline-delimited JSON to stderr (`backend/crates/yoneda-runtime/src/telemetry.rs`). The executable installs the subscriber once; library code only emits events. `yoneda-pack-builder` writes JSON lines to stdout.

Each check writes `check.started` and `check.finished` or `check.failed` with its `request_id`. They say nothing of what the check printed.

**Where these lines appear is unverified.** Cloudflare's Containers FAQ says Worker-level `observability` applies to containers by default and that logs reach the dashboard under the same limits as Workers Logs. It does not say whether they are in the Worker's Observability view or reach tail consumers, and neither can be shown locally.

## Costs and limits

From Cloudflare's docs, 2026-10-31. A line is at most 256 KB. Paid plans include 20 million log events a month, then $0.60 per million, kept 7 days. Above 5 billion a day, an account is sampled at 1%. From December 1, 2026, Workers Logs and container logs move to Cloudflare Observability pricing.
