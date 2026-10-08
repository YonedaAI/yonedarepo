use crate::storage::{SqlStore, string};
use serde_json::Value;
use yoneda_core::{Error, Result};
mod acceptance;
mod completion;
mod events;
mod history;
mod leases;
mod mcp;
mod policy;
mod repository;
mod runs;
mod scheduling;
mod typed_context;
pub(crate) fn dispatch<S: SqlStore>(db: &S, c: Value) -> Result<Value> {
    let now = c["now"].as_i64().unwrap_or_default();
    match string(&c, "op")?.as_str() {
        "update_policy" => policy::update(db, c, now),
        "init" | "snapshot" => repository::handle(db, c, now),
        "start_run" | "cancel_run" => runs::handle(db, c, now),
        "context_publish" | "context_search" | "context_get" => typed_context::handle(db, c, now),
        "claim" | "check_attempt" | "heartbeat" | "progress" | "fail" | "recover" => {
            leases::handle(db, c, now)
        }
        "context" | "publish_artifact" | "authorize_artifact" | "get_artifact"
        | "hint_complete" => mcp::handle(db, c, now),
        "outbox" | "outbox_sent" | "events" => events::handle(db, c, now),
        "why" | "graph" | "observe" | "decision" => history::handle(db, c, now),
        "finish" | "verify_finish" => completion::handle(db, c, now),
        "accept" => acceptance::handle(db, c, now),
        _ => Err(Error::new("NOT_FOUND", "Unknown repository operation")),
    }
}
