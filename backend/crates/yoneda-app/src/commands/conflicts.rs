//! Owner conflict inventory, refresh and scoped resolver operations.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
mod inventory;
mod refresh;
mod repair_authority;
mod resolver;
mod resolver_capture;
mod source;
mod support;
mod target;
pub(super) fn complete_resolver_capture<S: SqlStore>(
    db: &S,
    job: &Value,
    result: &Value,
    now: i64,
) -> Result<Value> {
    resolver_capture::complete_resolver_capture(db, job, result, now)
}
pub(super) fn resolver_evaluated<S: SqlStore>(
    db: &S,
    candidate: &str,
    eligible: bool,
    now: i64,
) -> Result<()> {
    resolver_capture::resolver_evaluated(db, candidate, eligible, now)
}
#[cfg(test)]
#[path = "tests/conflicts.rs"]
mod tests;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    match string(c, "op")?.as_str() {
        "conflict_status" => inventory::status(db, c),
        "conflict_paths" => source::paths(db, c),
        "refresh_candidate" => refresh::refresh(db, c, now),
        "resolve_conflict" => resolver::resolve(db, c, now),
        "conflict_refresh_complete" => refresh::complete(db, c, now),
        _ => Err(Error::new("NOT_FOUND", "Unknown conflict operation")),
    }
}

pub(crate) fn validate_source_resolution<S: SqlStore>(db: &S, record: &Value) -> Result<()> {
    repair_authority::validate_capture(db, &source::hydrate(db, record)?)
}
