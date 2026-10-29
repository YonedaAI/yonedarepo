//! How long the client waits on the platform. A connection that stays open without sending
//! anything (seen live: a clone parked for minutes on one socket) would otherwise be
//! waited on forever.
//!
//! - `YONEDA_IDLE_TIMEOUT_SECS` (default 30): the longest wait for the next bytes of an
//!   answer, and for an object transfer's answer to start. Past it the read counts as cut
//!   off, so object transfers resume from what arrived.
//! - `YONEDA_FETCH_BUDGET_SECS` (default 1800): the longest one object fetch (a set of
//!   wanted objects, its pages and large-blob downloads) may take in all.
//!
//! A value that is not a whole number of seconds above zero leaves the default.
use std::time::Duration;

const IDLE_SECS: u64 = 30;
const BUDGET_SECS: u64 = 1800;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub idle: Duration,
    pub budget: Duration,
}

impl Timeouts {
    pub fn from_env() -> Self {
        Self::from_values(
            std::env::var("YONEDA_IDLE_TIMEOUT_SECS").ok().as_deref(),
            std::env::var("YONEDA_FETCH_BUDGET_SECS").ok().as_deref(),
        )
    }

    fn from_values(idle: Option<&str>, budget: Option<&str>) -> Self {
        let secs = |value: Option<&str>, default: u64| {
            let parsed = value.and_then(|v| v.trim().parse::<u64>().ok());
            Duration::from_secs(parsed.filter(|s| *s > 0).unwrap_or(default))
        };
        Self {
            idle: secs(idle, IDLE_SECS),
            budget: secs(budget, BUDGET_SECS),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_whole_seconds_and_keeps_the_default_otherwise() {
        let t = Timeouts::from_values(Some("5"), Some(" 60 "));
        assert_eq!(
            (t.idle, t.budget),
            (Duration::from_secs(5), Duration::from_secs(60))
        );
        for bad in [None, Some("0"), Some("-1"), Some("1.5"), Some("soon")] {
            let t = Timeouts::from_values(bad, bad);
            assert_eq!(
                (t.idle.as_secs(), t.budget.as_secs()),
                (IDLE_SECS, BUDGET_SECS)
            );
        }
    }
}
