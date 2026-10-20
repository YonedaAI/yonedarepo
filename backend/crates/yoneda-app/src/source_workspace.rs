//! Isolated attempt/view staging authority. All operations use synchronous SQL transactions.
use crate::storage::{SqlStore, bad, create, get, number, save, string};
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result, source_changeset::*, source_workspace::*};
mod auth;
mod checkpoints;
mod gc;
mod migration;
mod mutations;
mod reads;
mod rows;
mod state;
mod tickets;
pub(crate) use auth::{sign_actor, sign_capture, sign_read_actor, verify_seal};
pub use migration::migrate_source_workspace;
use state::*;

pub fn execute_source_workspace<S: SqlStore>(db: &S, c: Value) -> Result<Value> {
    migrate_source_workspace(db)?;
    let owned = db.clone();
    db.transaction(Box::new(move || dispatch(&owned, &c)))
}
fn dispatch<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let op = string(c, "op")?;
    if op == "source_init" {
        return state::init(db, c);
    }
    if op == "source_gc_due" {
        return gc::due(db, c);
    }
    let mut state = get(db, "sw_state", "workspace")?;
    let binding: SourceBinding = decode(&state["binding"])?;
    if op.starts_with("source_gc_") {
        auth::gc(c, &binding)?;
        return gc::handle(db, c, &state);
    }
    if c.get("_capture_grant").is_some() {
        if op != "source_manifest" {
            return Err(Error::new(
                "FORBIDDEN",
                "Capture capability is read-only manifest authority",
            ));
        }
        auth::capture(c, &binding, &state)?;
        return checkpoints::manifest(db, c);
    }
    let actor = auth::actor(c, &binding)?;
    if op == "source_manifest" {
        if actor.claims.purpose != ActorPurpose::Supervisor {
            return Err(Error::new(
                "FORBIDDEN",
                "Manifest metadata is supervisor-only",
            ));
        }
        return checkpoints::manifest(db, c);
    }
    match op.as_str() {
        "source_status" => {
            let mut result = status(&state, actor.claims.purpose);
            result["access"] = json!(actor.claims.access);
            return Ok(result);
        }
        "source_stat" | "source_list" | "source_read" => return reads::handle(db, c, &state),
        "source_events" => return reads::events(db, c),
        _ => {}
    }
    if actor.claims.access != SourceAccess::ReadWrite {
        return Err(Error::new(
            "FORBIDDEN",
            "Read-only grant cannot mutate staged source",
        ));
    }
    if ["source_seal", "source_verify_upload"].contains(&op.as_str())
        && actor.claims.purpose != ActorPurpose::Supervisor
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Source transition requires supervisor authority",
        ));
    }
    if let Some(receipt) = replay(db, c)? {
        return Ok(receipt);
    }
    if state["status"] != "open" {
        return Err(Error::new("SOURCE_SEALED", "Source view is sealed"));
    }
    let receipt = match op.as_str() {
        "source_upload_ticket" | "source_verify_upload" => {
            tickets::handle(db, c, &mut state, &binding, &actor)?
        }
        "source_create" | "source_write" | "source_truncate" | "source_delete" | "source_chmod"
        | "source_copy" | "source_rename" => mutations::handle(db, c, &mut state, &binding)?,
        "source_checkpoint" | "source_seal" => checkpoints::handle(db, c, &mut state, &binding)?,
        _ => return Err(Error::new("NOT_FOUND", "Unknown source operation")),
    };
    record(db, c, &mut state, &receipt)?;
    Ok(receipt)
}
fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|_| bad("Invalid closed source contract"))
}
#[cfg(test)]
mod tests;
