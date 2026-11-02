//! Repository memories ("continuous memory"): what agents and people learned while working
//! (a decision, a constraint, a gotcha, a how-to, or a kind of their own), kept with the
//! code and handed to the next coding session when it is relevant, not only when the
//! session starts.
//! - `kinds`: the built-in kinds and the ones a repository added.
//! - `records`: append-only memories anchored to paths and symbols at a commit; retiring
//!   and superseding append rows too. Reads at a log version see what existed then.
//! - `stale`: whether the anchored code has changed since, from the log.
//! - `relevance`: one bounded, deterministic ranking of memories, contracts, recent
//!   sessions and open changes for a set of paths, symbols and/or query text.
//! - `deliveries`: what context a coding session was shown, and when.
//!
//! Every op describes the whole repository, so a path-restricted token can use none.
mod anchors;
mod candidates;
pub(super) mod deliveries;
pub(super) mod kinds;
mod listing;
pub(super) mod records;
pub(super) mod relevance;
mod stale;

use super::auth::Actor;
use super::op::MemoryOp;
use super::sessions::whole_repository;
use crate::storage::SqlStore;
use serde_json::Value;
use yoneda_core::Result;

pub(super) fn authorize(actor: &Actor, op: MemoryOp) -> Result<()> {
    match op {
        // A coding session that writes code records what it learned and what it was shown.
        MemoryOp::Add | MemoryOp::Retire | MemoryOp::Deliver => actor.require("write"),
        MemoryOp::List | MemoryOp::Show | MemoryOp::Relevant | MemoryOp::Deliveries => {
            actor.require("read")
        }
    }
}

pub(super) fn run<S: SqlStore>(db: &S, c: &Value, op: MemoryOp, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    match op {
        MemoryOp::Add => records::add(db, c, actor),
        MemoryOp::Retire => records::retire(db, c, actor),
        MemoryOp::List => listing::list(db, c),
        MemoryOp::Show => records::show(db, c),
        MemoryOp::Relevant => relevance::relevant(db, c, actor),
        MemoryOp::Deliver => deliveries::deliver(db, c, actor),
        MemoryOp::Deliveries => deliveries::list(db, c),
    }
}
