//! Owner conflict inventory, refresh and the link to a sandbox resolver run.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
mod inventory;
mod refresh;
mod sandbox_resolver;
mod source;
mod support;
mod target;
#[cfg(test)]
#[path = "tests/conflicts.rs"]
mod tests;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    match string(c, "op")?.as_str() {
        "conflict_status" => inventory::status(db, c),
        "conflict_paths" => source::paths(db, c),
        "refresh_candidate" => refresh::refresh(db, c, now),
        // Conflicts resolve in a sandbox run the adapter starts and links below.
        "resolve_conflict" => Err(Error::new(
            "SANDBOX_REQUIRED",
            "Conflicts are resolved in a sandbox run",
        )),
        "conflict_resolver_run" => sandbox_resolver::link(db, c, now),
        "conflict_refresh_complete" => refresh::complete(db, c, now),
        _ => Err(Error::new("NOT_FOUND", "Unknown conflict operation")),
    }
}
