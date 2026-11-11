# Repository observability implementation

## Request budget

Observe existing work only: no extra repository calls, database queries, queue messages,
repository activation, payload buffering, or awaited telemetry requests. A completed operation
writes at most one versioned Analytics Engine point. Detailed logs are at most 4 KB; identifiers
and parent links stay in private logs, never aggregate dimensions. Existing telemetry formats
remain readable. Telemetry failures never fail product requests.

Dev retains detailed metadata. Production captures complete safe metadata until an explicit UTC
expiry, set to 48 hours after activation; after expiry normal details are sampled at 10%, while
failures and operations over the existing five-second diagnostic threshold remain captured.
Aggregate measurements do not use that sampling decision. Cloudflare adaptive sampling and
missing coverage must be shown. No new latency emails or arbitrary service targets.

Record trigger, operation, result, attempt, response readiness, transfer completion, queue wait,
cache/storage waits and known routing location separately. Unknown is never zero or a claimed
client identity. Git completion on the server is not proof of receipt on the client's machine.

## Verification and activation

Targeted workerd tests cover causal propagation, concurrent/retried operations, capture expiry,
privacy, transfer failures, and telemetry that performs no repository lookup. Dev acceptance uses
real-history repositories, web/CLI/MCP/Git and background jobs. Compare three runs of the existing
1,000-writer workload, recording server timing and min/median/max before production promotion.
Use the normal release path; enable production capture only after dev acceptance. Keep existing
failure and outage checks, and leave synthetic repository probes off.

Implementation and live acceptance are separate; this document does not attest either.

## Instruments

`operation.v1` in the existing site-events dataset is separate from visit and legacy service
points. Counts and latency distributions group by service, API region, release, operation,
trigger, traffic claim, verified credential kind and result. The SQL reader weights Cloudflare's
`_sample_interval`; sampled counts are estimates. Missing data, missing queue age and unavailable
queries stay unknown. The Admin Infrastructure tab reads these aggregates on demand; it makes
two parallel Analytics Engine queries and never queries a repository for this report.

- `request.operation` ends when the response is ready. `request.spans` keeps the existing
  cache, storage and authority waits; the JavaScript clock does not measure CPU between I/O.
- `repository.operation` measures authority round trips and holder RPC calls. A `/batch` timing
  belongs to the whole batch. Individual commands have native `repository.command` events,
  including whether this was the authority instance's first request. Do not divide a batch
  duration into invented command timings or treat an activation marker as startup duration.
- `landing.batch_link` connects a shared landing batch to each submitting request. Each
  `landing.result` measures that submitter's actual wait, including time in the combiner.
- `transfer.operation` records server pack completion, bytes and interruptions separately from
  response readiness. Built packs distinguish cancellation; a stored pipe interrupted by either
  side reports failed completion. Its first-byte field marks server preparation/write, not
  client receipt. Receive-pack records protocol refusals even when HTTP reports 200.
- Queue jobs retain the producer link, attempt and known ready-queue wait. Imported and managed
  workflow steps retain their originating request metadata. Cron and projector alarms identify
  their own trigger; a helper returning no completion evidence reports unknown, not success.
- Signed SSH session metadata joins the authorized Git requests to the session request.
  The lifetime of an SSH tunnel is never reported as clone or push latency.
- Browser reports distinguish response TTFB, API consumer wait, primary-content readiness and
  README readiness. A cold navigation starts at document navigation; an in-app navigation
  starts at its route change. Deferred images are not included. Browser reports are untrusted
  observations, not proof of a human or of a committed write. Old navigation requests cannot be
  assigned to the next navigation. Existing browser error and Web Analytics paths remain.

Private log ids connect these events. Aggregate dimensions contain no user, repository, file,
request, navigation, SSH-key or token identity. Payloads and credentials are not recorded.
Metadata is not authorization. Telemetry emission is best effort: a sink error does not fail the
operation, and a bounded `operation.metric_lost` warning makes that loss visible in logs.
Cloudflare log retention and capture coverage still apply; no claim of perfect delivery is made.

The legacy visit ping now uses static pages or a bounded, origin-specific five-minute record of
public pages already served by the isolate. A miss drops the ping; it makes no repository
lookup. That record is recent public-page evidence, not a fresh visibility decision or access
grant. The new performance beacon never resolves a repository or account.

## Capture control

Dev uses `OPERATION_DETAIL_EVERY=1`; production uses `10`. `OPERATION_COMPONENT` separates the
front, platform and managed service so their nested requests never form one mixed population.
`REQUEST_IDS`, `OPERATION_METRICS` and the front's `CLIENT_PERFORMANCE` enable the instruments.
An explicit `OPERATION_FULL_UNTIL` UTC timestamp temporarily selects every safe detail. Invalid
or expired values do not enable full capture. Delayed messages cannot extend an expired full
capture. Metric points and failure/slow detail retention are independent of the normal detail
sample. The five-second cutoff selects diagnostics; it is not a service target or email rule.

Set the production expiry only after dev acceptance, immediately before the production wave,
using the generated environment specs. Verify the deployed timestamp, service revisions and
new points after activation; record the actual capture interval. Neither a committed config nor
a passing test proves that production is collecting anything.
