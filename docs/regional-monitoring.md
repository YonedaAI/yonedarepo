# Regional monitoring

## Request budget, written before implementation

This change adds no work to customer requests: no logs, headers, points,
subrequests, storage calls or awaited work.

The infrastructure generator supplies an explicit same-environment backend
allowlist from the API aliases and bound authority providers. The wide watch
counts their native exceptions, unexpected terminations, CPU/memory kills and
error logs in a separate `backend_execution` series. These are executions, not customer HTTP requests:
forwarding can produce several executions for one customer operation. This
series raises native-failure signals only, never HTTP error-rate or latency
signals. A propagated exception can appear in several executions; it never
becomes several failed customer requests. Existing entry/frontend denominators
and latency baselines stay intact.

The existing tail ledger stores the additional component using its existing
48-hour retention. A tail batch adds at most one component row per minute,
with the same bounded samples and redaction. Unexpected termination marks use
the existing 20-hour incident window. No new scheduled or model pass.

For each configured regional authority, a watch pass reuses the primary queue
and container inventory and reads one additional Worker-settings response plus
one additional GraphQL response. Today there is one such authority (Europe).
Those reads use existing tokens, timeouts and failure reporting. Discovery is
shared only inside one watch-pass source instance and retried after failure.
With manually configured primary IDs, regional discovery also needs the two
queue/container inventory reads that the primary previously skipped. Regional
resource signals remain separate from US resources; an improving US backlog
cannot hide a growing European backlog. Missing or failed regional telemetry
is a telemetry error, never a zero reading.

## Coverage and limits

Regional native failures reach the existing findings and notification path.
Completed API/Git requests retain their existing shared service measurements.
Browser reporting and synthetic probe switches are unchanged.

Shared request-death points still cover only the original primary entry.
An alias or regional authority that dies is now visible in native diagnostics,
but its death is not added to customer service-level counts. Counting it there
requires a separate ownership design that also excludes forwarding and internal
subrequests; blindly counting every hop would duplicate failures. Direct alias
traffic and browser requests that bypass the primary therefore remain outside
that death-point coverage. This patch does not claim to close that limit.
