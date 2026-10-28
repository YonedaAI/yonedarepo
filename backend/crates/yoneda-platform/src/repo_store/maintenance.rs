//! Maintenance off the commit path: vacuum (releasing hidden refs, and the pins that keep
//! them) and log compaction (moving old versions to the object store).
pub(super) mod archive;
mod compaction;
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
        M::VacuumPlan | M::VacuumDone if !(actor.owner || actor.can("system")) => Err(Error::new(
            "FORBIDDEN",
            "Vacuum is run by the owner or the platform",
        )),
        // Compaction: the owner's trigger or the platform's compaction job.
        M::CompactPlan | M::CompactDone if !actor.can("compact") => actor.require_owner(),
        M::SetRetention => actor.require_owner(),
        M::Pin => actor.require("write"),
        M::VacuumPlan | M::VacuumDone | M::CompactPlan | M::CompactDone => actor.require("read"),
    }
}

pub(super) fn run<S: SqlStore>(db: &S, c: &Value, op: M, principal: &str) -> Result<Value> {
    match op {
        M::Pin => vacuum::pin(db, c, principal),
        M::VacuumPlan => vacuum::plan(db, c),
        M::VacuumDone => vacuum::done(db, c),
        M::CompactPlan => compaction::plan(db, c),
        M::CompactDone => compaction::done(db, c),
        M::SetRetention => compaction::set_retention(db, c),
    }
}
