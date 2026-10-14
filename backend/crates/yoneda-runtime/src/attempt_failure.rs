//! Ledger retry disposition for a failed attempt, decided from typed failure codes.
//!
//! Hosted agent attempts spend model allowance and may delegate, so their failures are
//! terminal by default. The one exception is a harness stopped from outside the attempt
//! (container rollout or eviction): the ledger then requeues a fresh epoch in a new
//! container, bounded by its attempt limit, the job deadline and the shared run budget.
use crate::harness_error::INTERRUPTED;
use yoneda_core::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Disposition {
    /// The ledger may requeue a fresh attempt while its attempt budget allows.
    Retry,
    /// The failure is recorded as final for this job.
    Terminal,
}
impl Disposition {
    pub(crate) fn retryable(self) -> bool {
        self == Self::Retry
    }
}

pub(crate) fn disposition(kind: &str, error: &Error) -> Disposition {
    if kind != "agent" {
        // Capture, evaluation and publication are trusted, idempotent and fenced by epoch.
        return Disposition::Retry;
    }
    // Only `harness_error::failure` produces this code, from exit evidence alone.
    if error.code == INTERRUPTED {
        Disposition::Retry
    } else {
        Disposition::Terminal
    }
}

#[cfg(test)]
#[path = "tests/attempt_failure.rs"]
mod tests;
