//! Maintenance off the commit path: vacuum's gate, pins and log compaction (moving old versions to the object store).
pub(super) mod archive;
mod compaction;
mod retention;
pub(super) mod supplied;
mod vacuum;
use super::auth::Actor;
use super::op::MaintenanceOp as M;
use crate::storage::SqlStore;
use serde_json::Value;
/// Archived log objects a command carries are visible to its checks for that command.
pub(super) use supplied::scoped;
use yoneda_core::{Error, Result};

pub(super) fn authorize(actor: &Actor, op: M) -> Result<()> {
    match op {
        M::VacuumPlan if !(actor.owner || actor.can("system")) => Err(Error::new(
            "FORBIDDEN",
            "Vacuum is run by the owner or the platform",
        )),
        // Compaction: the owner's trigger or the platform's compaction job.
        M::CompactStatus | M::CompactPlan | M::CompactDone if !actor.can("compact") => {
            actor.require_owner()
        }
        M::SetRetention => actor.require_owner(),
        M::Pin => actor.require("write"),
        M::VacuumPlan | M::CompactStatus | M::CompactPlan | M::CompactDone => actor.require("read"),
    }
}

pub(super) fn run<S: SqlStore>(db: &S, c: &Value, op: M, principal: &str) -> Result<Value> {
    match op {
        M::Pin => vacuum::pin(db, c, principal),
        // Nothing to plan: this is the gate in front of `repo_vacuum` (owner, legal hold).
        M::VacuumPlan => Ok(serde_json::json!({})),
        M::CompactStatus => compaction::status(db, c),
        M::CompactPlan => compaction::plan(db, c),
        M::CompactDone => compaction::done(db, c),
        M::SetRetention => retention::set_retention(db, c, principal),
    }
}
