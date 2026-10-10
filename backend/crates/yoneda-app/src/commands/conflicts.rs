//! Owner conflict inventory, refresh and scoped resolver operations.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
mod inventory;
mod refresh;
mod resolver;
mod support;
#[cfg(test)]
#[path = "tests/conflicts.rs"]
mod tests;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    match string(c, "op")?.as_str() {
        "conflict_status" => inventory::status(db, c),
        "refresh_candidate" => refresh::refresh(db, c, now),
        "resolve_conflict" => resolver::resolve(db, c, now),
        "conflict_refresh_complete" => refresh::complete(db, c, now),
        _ => Err(Error::new("NOT_FOUND", "Unknown conflict operation")),
    }
}
