//! Maintenance run by the owner or the platform, off the commit path: vacuum (releasing
//! hidden refs) and log compaction (moving old versions to the object store).
pub(super) mod archive;
mod compaction;
use super::{auth::Actor, vacuum};
use crate::storage::SqlStore;
use serde_json::Value;
use yoneda_core::{Error, Result};

const OPS: [&str; 5] = [
    "repo_vacuum_plan",
    "repo_vacuum_done",
    "repo_compact_plan",
    "repo_compact_done",
    "repo_set_retention",
];

pub(super) fn owns(op: &str) -> bool {
    OPS.contains(&op)
}

pub(super) fn authorize(actor: &Actor, op: &str) -> Result<()> {
    match op {
        "repo_vacuum_plan" | "repo_vacuum_done" if !(actor.owner || actor.can("system")) => Err(
            Error::new("FORBIDDEN", "Vacuum is run by the owner or the platform"),
        ),
        // Compaction: the owner's trigger or the platform's compaction job.
        "repo_compact_plan" | "repo_compact_done" if !actor.can("compact") => actor.require_owner(),
        "repo_set_retention" => actor.require_owner(),
        _ => actor.require("read"),
    }
}

pub(super) fn run<S: SqlStore>(db: &S, c: &Value, op: &str) -> Result<Value> {
    match op {
        "repo_vacuum_plan" => vacuum::plan(db, c),
        "repo_vacuum_done" => vacuum::done(db, c),
        "repo_compact_plan" => compaction::plan(db, c),
        "repo_compact_done" => compaction::done(db, c),
        "repo_set_retention" => compaction::set_retention(db, c),
        _ => Err(Error::new(
            "UNKNOWN_OP",
            format!("Unknown maintenance op {op}"),
        )),
    }
}
