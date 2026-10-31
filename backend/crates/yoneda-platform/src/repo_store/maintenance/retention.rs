//! How much of the log stays in SQL: a repository's `txlog_retention`, or the defaults.
use super::super::audit_outbox;
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use yoneda_core::Result;

pub(super) const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Defaults: entries leave once they are 10,000 versions behind the head or 30 days old,
/// whichever comes first, so the tail holds at most `keep_versions + SEGMENT_VERSIONS`.
const DEFAULT_KEEP_VERSIONS: u64 = 10_000;
const DEFAULT_KEEP_DAYS: i64 = 30;
const MIN_KEEP_VERSIONS: u64 = 64;
const MAX_KEEP_DAYS: i64 = 3_650;

pub(super) struct Retention {
    pub(super) keep_versions: u64,
    pub(super) keep_ms: i64,
}

impl Retention {
    pub(super) fn of<S: SqlStore>(db: &S) -> Result<Self> {
        let row = db
            .query(
                "SELECT keep_versions,keep_ms FROM txlog_retention WHERE id=1",
                &[],
            )?
            .into_iter()
            .next();
        Ok(Self {
            keep_versions: row
                .as_ref()
                .and_then(|r| r["keep_versions"].as_u64())
                .unwrap_or(DEFAULT_KEEP_VERSIONS),
            keep_ms: row
                .as_ref()
                .and_then(|r| r["keep_ms"].as_i64())
                .unwrap_or(DEFAULT_KEEP_DAYS * DAY_MS),
        })
    }

    pub(super) fn json(&self) -> Value {
        json!({ "keep_versions": self.keep_versions, "keep_days": self.keep_ms / DAY_MS })
    }
}

/// `repo_set_retention` (owner): `keep_versions` (at least 64) and/or `keep_days` (1-3650).
pub fn set_retention<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let mut retention = Retention::of(db)?;
    let before = retention.json();
    let field = |key: &str| c.get(key).filter(|v| !v.is_null());
    if field("keep_versions").is_none() && field("keep_days").is_none() {
        return Err(bad("Give keep_versions and/or keep_days"));
    }
    if let Some(v) = field("keep_versions") {
        retention.keep_versions = v
            .as_u64()
            .filter(|n| (MIN_KEEP_VERSIONS..=1_000_000_000).contains(n))
            .ok_or_else(|| bad("keep_versions must be a whole number of at least 64"))?;
    }
    if let Some(v) = field("keep_days") {
        retention.keep_ms = v
            .as_i64()
            .filter(|n| (1..=MAX_KEEP_DAYS).contains(n))
            .ok_or_else(|| bad("keep_days must be a whole number from 1 to 3650"))?
            * DAY_MS;
    }
    db.query(
        "INSERT INTO txlog_retention(id,keep_versions,keep_ms) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET keep_versions=excluded.keep_versions,keep_ms=excluded.keep_ms",
        &[json!(retention.keep_versions), json!(retention.keep_ms)],
    )?;
    let event = retention.json();
    if event != before {
        audit_outbox::record(db, c, "repo.retention_changed", principal, event)?;
    }
    Ok(retention.json())
}
