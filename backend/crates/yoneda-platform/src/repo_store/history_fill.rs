//! An imported history filled in behind its head (`FAST_IMPORT`). The head is recorded with
//! its true generation (`record_head`, the length of the chain) and lands at once, so the
//! code is readable; its first-parent ancestors then arrive newest first, in batches of one
//! transaction each (`repo_record_imported_batch`).
//!
//! Nothing marks a repository as filling. `ref_chain` depth equals generation along an
//! imported chain, so main's head being an imported commit of generation `total` whose
//! chain stops above depth 1 is the state itself: read in two indexed lookups, and it ends
//! with the transaction that records generation 1. A truncated import ends the same way:
//! its oldest commit has generation 1 and parents that are never recorded.
//!
//! While filling, graph reads stop where the chain stops, as at a truncated import, and
//! every read of history carries `history_import` so that a partial answer never reads as
//! complete. Nothing moves a ref or starts new history (`refuses`): the chain stays the
//! branch's own, a fork cannot copy half of it and a fetch cannot get a commit without its
//! parents: those come from the mirror, which already holds them all (the adapter's
//! `repo-git-mirror`). A fill that cannot finish ends where it reached (`end`).
use super::op::{ForkOp as F, QuarantineOp as Q, RepoOp as R, StoreOp};
use crate::storage::SqlStore;
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

mod end;
mod record;

pub(super) use end::{HistoryStopped, end, stopped};
pub(super) use record::record_batch;
pub(super) use record::record_head;
#[cfg(test)]
pub(super) use record::{Imported, chunks};

const MAIN: &str = "refs/heads/main";

/// How far an imported history has been recorded behind its landed head.
#[derive(Debug, Clone, Copy, Serialize, JsonSchema)]
pub struct HistoryFill {
    pub recorded: u64,
    pub total: u64,
}

impl HistoryFill {
    /// The depth (and generation) of the oldest commit recorded so far.
    pub(crate) fn oldest(self) -> u64 {
        self.total - self.recorded + 1
    }
}

/// How far main's imported history has come, while it is still being filled.
pub fn filling<S: SqlStore>(db: &S) -> Result<Option<HistoryFill>> {
    let head = db.query(
        "SELECT c.generation FROM refs r JOIN commits c ON c.id=r.commit_id \
         WHERE r.name=? AND c.origin='import'",
        &[json!(MAIN)],
    )?;
    let Some(total) = head.first().and_then(|row| row["generation"].as_u64()) else {
        return Ok(None);
    };
    let chain = db.query(
        "SELECT MIN(depth) AS oldest FROM ref_chain WHERE ref=?",
        &[json!(MAIN)],
    )?;
    let oldest = chain.first().and_then(|row| row["oldest"].as_u64());
    // A chain started past its limit lies above every generation (`ref_chain`).
    Ok(oldest
        .filter(|oldest| (2..=total).contains(oldest))
        .map(|oldest| HistoryFill {
            recorded: total - oldest + 1,
            total,
        }))
}

/// Ops refused while filling: anything that moves a ref, starts new history, copies or
/// sends what is not all here yet, or would retire the mirror the fill reads. A submitted
/// landing is refused alone (`submitted`): the batch it came in must still answer. The
/// merger's own ops land queued tickets, and none are queued while refused here.
pub(super) fn refuses(op: StoreOp) -> bool {
    matches!(
        op,
        StoreOp::Repo(
            R::BeginCommit
                | R::BisectStart
                | R::BisectStep
                | R::BranchBatch
                | R::BranchSet
                | R::BreakGlass
                | R::GitWalk
                | R::Land
                | R::LandEnqueue
                | R::PrepareCommit
                | R::RecordCommit
                | R::RecordPushed
                | R::ReleaseCreate
                | R::TagCreate
        ) | StoreOp::Fork(F::Source | F::Export | F::Offer | F::Branch)
            | StoreOp::Quarantine(Q::Purge)
    )
}

/// `IMPORT_IN_PROGRESS` while filling.
pub(super) fn refuse_if_filling<S: SqlStore>(db: &S) -> Result<()> {
    match filling(db)? {
        None => Ok(()),
        Some(fill) => Err(Error::new(
            "IMPORT_IN_PROGRESS",
            format!(
                "This repository's history is still importing ({} of {} commits): it takes no \
                 changes until that finishes. Its files can be read and cloned now",
                fill.recorded, fill.total
            ),
        )),
    }
}

/// Adds to a read of history that it is partial: `history_import` while it fills, and
/// `history_stopped` once a fill ended early.
pub(super) fn note<S: SqlStore>(db: &S, mut answer: Value) -> Result<Value> {
    if let Some(fill) = filling(db)? {
        answer["history_import"] = json!(fill);
    }
    if let Some(stopped) = stopped(db)? {
        answer["history_stopped"] = json!(stopped);
    }
    Ok(answer)
}

/// The refusal for a commit no row holds: one still to come says so.
pub(super) fn not_recorded<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Error> {
    let detail = filling(db)?.map_or(String::new(), |fill| {
        format!(
            " yet: history is still importing ({} of {} commits)",
            fill.recorded, fill.total
        )
    });
    Ok(Error::new(
        "NOT_FOUND",
        format!("Commit {id} is not recorded{detail}"),
    ))
}
