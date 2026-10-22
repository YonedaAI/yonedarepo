//! Idle watchdog: an agent attempt stops when it stops making progress, not at a wall clock.
//!
//! Progress is any harness output (stream-json model responses and tool events), any source
//! filesystem request served by this supervisor, or ledger-observed model activity reported by
//! the heartbeat (which covers time spent waiting on a provider). A hard ceiling remains as a
//! safety net. The ledger keeps a matching rolling deadline that trails this watchdog.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::time::Instant;

/// In-process progress signals; one attempt runs per container.
static SIGNALS: AtomicU64 = AtomicU64::new(0);

/// Record progress observed inside the supervisor process (for example ledger model activity).
pub(crate) fn note() {
    SIGNALS.fetch_add(1, Ordering::Relaxed);
}

/// All in-process progress: explicit notes plus source filesystem requests.
pub(crate) fn signals() -> u64 {
    SIGNALS
        .load(Ordering::Relaxed)
        .wrapping_add(crate::source_client_api::source_requests())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Limits {
    /// `None` keeps a pure wall-clock limit (evaluation, capture, publication, legacy runs).
    pub(crate) idle: Option<Duration>,
    pub(crate) ceiling: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Expiry {
    Idle(Duration),
    Ceiling(Duration),
}

impl Expiry {
    /// Plain, actionable failure text. The code prefix stays `EXECUTION_TIMEOUT`.
    pub(crate) fn message(self) -> String {
        match self {
            Self::Idle(idle) => format!(
                "EXECUTION_TIMEOUT: No agent progress for {} min (no model response, tool call or file change). Retry resumes from the files it already wrote.",
                minutes(idle)
            ),
            Self::Ceiling(ceiling) => format!(
                "EXECUTION_TIMEOUT: Attempt reached the {} min safety ceiling while still working. Retry resumes from the files it already wrote.",
                minutes(ceiling)
            ),
        }
    }

    /// A stall may be a provider hang worth one automatic retry; a ceiling hit waits for the owner.
    pub(crate) fn retryable(self) -> bool {
        matches!(self, Self::Idle(_))
    }
}

fn minutes(duration: Duration) -> u64 {
    duration.as_secs().div_ceil(60)
}

/// Resolve when the attempt is idle for `limits.idle` or reaches `limits.ceiling`.
/// `progress` returns a monotonically increasing count of observed progress signals.
pub(crate) async fn expired(limits: Limits, tick: Duration, progress: impl Fn() -> u64) -> Expiry {
    let started = Instant::now();
    let mut seen = progress();
    let mut last = started;
    loop {
        tokio::time::sleep(tick).await;
        let now = Instant::now();
        let current = progress();
        if current != seen {
            seen = current;
            last = now;
        }
        if now.duration_since(started) >= limits.ceiling {
            return Expiry::Ceiling(limits.ceiling);
        }
        if let Some(idle) = limits.idle
            && now.duration_since(last) >= idle
        {
            return Expiry::Idle(idle);
        }
    }
}

#[cfg(test)]
#[path = "tests/attempt_watchdog.rs"]
mod tests;
