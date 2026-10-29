//! When a failed call is worth repeating, and how long to wait first.
use super::Failure;

/// No answer, an unreadable one, a gateway error or an overloaded platform (503
/// OVERLOADED): worth retrying a call that is safe to repeat.
pub(crate) fn transient(failure: &Failure) -> bool {
    matches!(failure.status, 0 | 502 | 503 | 504)
}

/// Retries after the first attempt, and the longest `Retry-After` honoured.
pub(super) const RETRIES: u64 = 3;
const MAX_RETRY_AFTER_SECONDS: u64 = 10;

/// The wait before retry `attempt` (1-based): the platform's `Retry-After` when it gave one,
/// else a linear backoff, plus up to 250 ms of jitter so retrying clients spread out.
fn backoff(failure: &Failure, attempt: u64) -> std::time::Duration {
    let base = failure
        .retry_after
        .map_or(1000 * attempt, |s| 1000 * s.min(MAX_RETRY_AFTER_SECONDS));
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_nanos()) % 250);
    std::time::Duration::from_millis(base + jitter)
}

/// Waits before retry `attempt` (1-based) of a call that failed with `failure`.
pub(crate) async fn pause(failure: &Failure, attempt: u64) {
    tokio::time::sleep(backoff(failure, attempt)).await;
}
