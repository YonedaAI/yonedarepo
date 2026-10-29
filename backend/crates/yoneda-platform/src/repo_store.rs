//! The YonedaRepo source platform authority: recorded commits, refs, the hash-chained
//! transaction log, checks, reviews and landing. It knows API principals only, never
//! agents or runs. Every operation is synchronous SQL; object-store I/O (Artifacts, R2)
//! happens in the adapter before `repo_record_commit` and never inside a transaction.
//!
//! Event sourcing covers refs only: the log replays to the ref map at any version
//! (`checkpoints`). Commit records (`record`), check results (upserted per commit, name and
//! policy digest in `checks`) and reviews are rows keyed by commit id; replaying the log
//! does not rebuild them.
//!
//! Object-store writes are never atomic with the row commit. Two mechanisms cover the gap:
//! the staged-objects outbox (`staging`: objects held here with an outbox row in the same
//! transaction, written to R2 afterwards and dropped only once confirmed) and readback
//! (`record`: a commit built for the object store is recorded only after the adapter reads
//! it back, refusing a mismatch with `READBACK_MISMATCH`).
use crate::storage::SqlStore;
use serde_json::Value;
use yoneda_core::Result;
mod activity;
mod adopt;
mod agent_context;
mod agent_reads;
mod annotated;
pub(crate) mod auth;
mod authorize;
mod bisect;
mod branches;
mod break_glass;
mod change_comments;
mod change_delete;
mod change_hooks;
mod change_records;
mod changes;
mod changesets;
mod check_evidence;
mod checkpoints;
mod checks;
mod classes;
mod contracts;
mod deletion;
mod dispatch;
mod fork_copy;
mod forks;
mod git_http;
mod git_shallow;
mod git_wanted;
pub(crate) mod grants;
mod head;
mod history;
mod history_import;
mod hook_delivery;
mod hook_events;
mod hook_url;
mod hooks;
mod land;
mod land_queue;
mod land_tickets;
mod lfs;
mod maintenance;
pub(crate) mod members;
mod memory;
mod merging;
pub(crate) mod migration;
pub(crate) mod op;
mod org_access;
pub(crate) mod policy;
pub(crate) mod prepare;
mod projection;
mod projection_plan;
mod pushed;
mod quarantine;
mod reads;
mod rebase;
mod record;
mod ref_chain;
mod releases;
mod reviewers;
mod rows;
mod runner;
mod session_range;
mod sessions;
pub(crate) mod staging;
pub(crate) mod status;
mod store_lineage;
mod submitted;
mod symbols;
mod tags;
mod tokens;
mod tree_cache;
mod version_projection;
mod visibility;
pub use migration::migrate_repo_store;
pub(crate) use rows::protected as protected_ref;

pub fn execute_repo_store<S: SqlStore>(db: &S, command: Value) -> Result<Value> {
    migrate_repo_store(db)?;
    execute_migrated(db, command)
}

/// One command against a store this process already migrated.
pub fn execute_migrated<S: SqlStore>(db: &S, command: Value) -> Result<Value> {
    let owned = db.clone();
    db.transaction(Box::new(move || {
        maintenance::scoped(&command, || dispatch::dispatch(&owned, &command))
    }))
}

#[cfg(test)]
mod tests;
