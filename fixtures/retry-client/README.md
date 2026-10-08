# Retry client fixture

The initial client makes one request. Explore safe transient retries without external dependencies.

`cargo run -- GET 503,200 20 200 3`

The contract is `retry-client METHOD STATUSES LATENCY_MS BUDGET_MS MAX_ATTEMPTS`, with JSON output containing `attempts`, `elapsed_ms` and `status`. Retry GET only, for 429 or server errors. Backoff is 10 ms, 20 ms, 40 ms, and so on. Include all latency and backoff in the total deadline; always perform the first request; clamp attempts to 1–10. Statuses repeat the final supplied value if exhausted.

The research task should identify bounded assumptions, including the working upstream p99 latency assumption of 100 ms. Incident observations in the demo are explicitly simulated.
