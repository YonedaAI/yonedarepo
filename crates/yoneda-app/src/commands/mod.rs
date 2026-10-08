use crate::storage::{SqlStore, string};
use serde_json::Value;
use yoneda_core::{Error, Result};
mod acceptance;
mod completion;
mod events;
mod external;
mod history;
mod leases;
mod mcp;
mod policy;
mod repository;
mod resources;
mod runs;
mod scheduling;
mod sites;
mod transcripts;
mod typed_context;
pub(crate) fn dispatch<S: SqlStore>(db: &S, c: Value) -> Result<Value> {
    let now = c["now"].as_i64().unwrap_or_default();
    // This field is set by the authenticated adapter, after discarding caller authority fields.
    if let Some(workspace) = c["_workspace"].as_str()
        && workspace != "_admin"
        && c["op"] != "init"
    {
        let repository = crate::storage::repo(db)?;
        if repository["workspace"].as_str().unwrap_or("_admin") != workspace {
            return Err(Error::new(
                "FORBIDDEN",
                "Repository belongs to another workspace",
            ));
        }
    }
    match string(&c, "op")?.as_str() {
        "external_begin" | "external_check" | "external_status" | "external_freeze"
        | "external_bind" | "external_submit" => external::handle(db, c, now),
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
        "register_site" => sites::register(db, c, now),
        "record_transcript" => transcripts::record(db, c, now),
        "reserve_request" => resources::reserve(db, c),
        _ => Err(Error::new("NOT_FOUND", "Unknown repository operation")),
    }
}
