//! The YonedaRepo source platform authority: recorded commits, refs, the hash-chained
//! transaction log, checks, reviews and landing. It knows API principals only, never
//! agents or runs. Every operation is synchronous SQL; object-store I/O (Artifacts, R2)
//! happens in the adapter before `repo_record_commit` and never inside a transaction.
use crate::storage::{SqlStore, string};
use serde_json::Value;
use yoneda_core::{Error, Result};
mod auth;
mod land;
mod migration;
mod prepare;
mod reads;
mod record;
mod rows;
pub use migration::migrate_repo_store;

pub fn execute_repo_store<S: SqlStore>(db: &S, command: Value) -> Result<Value> {
    migrate_repo_store(db)?;
    let owned = db.clone();
    db.transaction(Box::new(move || dispatch(&owned, &command)))
}

fn dispatch<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let op = string(c, "op")?;
    if op == "repo_init" {
        return rows::init(db, c);
    }
    let settings = rows::settings(db)?;
    let actor = auth::actor(db, c, &settings)?;
    let scope = match op.as_str() {
        "repo_prepare_commit" | "repo_record_commit" => "write",
        "repo_check" => "check",
        "repo_review" => "review",
        "repo_land" => "land",
        _ => "read",
    };
    actor.require(scope)?;
    let principal = actor.principal.as_str();
    match op.as_str() {
        "repo_status" => reads::status(db, &settings),
        "repo_refs" => reads::refs(db, c),
        "repo_snapshot" => reads::snapshot(db, c),
        "repo_log" => reads::log(db, c),
        "repo_txlog" => reads::txlog(db, c),
        "repo_commit" => reads::commit(db, c, &settings),
        "repo_prepare_commit" => prepare::prepare(db, c, principal),
        "repo_record_commit" => record::record(db, c, principal),
        "repo_check" => record::check(db, c, principal, &settings),
        "repo_review" => record::review(db, c, principal),
        "repo_land" => land::land(db, c, principal, &settings),
        "repo_import" => {
            actor.require_owner()?;
            land::import(db, c, principal)
        }
        "repo_token_create" => auth::create_token(db, c, &actor),
        "repo_token_revoke" => auth::revoke_token(db, c, &actor),
        "repo_tokens" => auth::list_tokens(db, &actor),
        _ => Err(Error::new(
            "UNKNOWN_OP",
            format!("Unknown platform op {op}"),
        )),
    }
}

#[cfg(test)]
mod tests;
