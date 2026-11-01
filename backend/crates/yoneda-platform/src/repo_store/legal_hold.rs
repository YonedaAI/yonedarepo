//! Legal hold at the authority. The hold itself lives in the owner's account authority
//! (`accounts::holds`), so an org's hold covers repositories made later and survives a
//! rollback of this binary; never in `policy`, which an older binary would fail to parse
//! on every op, and which passed checks are bound to.
//!
//! A destructive op runs only on a verified answer: the adapter sets `_hold` (never from
//! client input) to the owner's answer, or to `"off"` while the `LEGAL_HOLD` switch is. With
//! no such answer the op answers `HOLD_UNCHECKED` naming the owner; the adapter asks that
//! authority and sends the op again. So an op added to this list is covered with no adapter
//! change, a command that never had an answer fails closed, and nothing off the list pays.
//!
//! The list is deny-by-name, like `capacity::refuses`. What a hold protects is data going
//! away for good: `repo_quarantine_purged` and `repo_vacuum_done` stay off it because they
//! report what already happened. Landing, compaction (which moves the log to the object
//! store), retiring memories, the LFS orphan sweep, branch deletion (vacuum is what would
//! lose the history) and member removal stay off it too, as does withholding: quarantine
//! keeps content from being served, only its purge is held. `repo_erase_plan` only reads,
//! and a backfill sends it knowing no repository to ask about; the erase's first destructive
//! step is the shards' `store_erase`, which waits for an answer of its own (`commit_store`).
//!
//! `repo_audit_set_aside` is on it: a corrupt row's bytes go for good, and they may be evidence.
//!
//! The undo window's purge goes through `repo_purge_target` and needs nothing new. Landing stays
//! off the list, but the platform's own landing asks anyway (`land_when_cleared/state.rs`): with a person
//! landing, a person answers for it.
use super::op::{MaintenanceOp as M, QuarantineOp as Q, RepoOp as R, StoreOp};
use serde_json::Value;
use yoneda_core::{Error, Result};

/// Ops that destroy what a hold protects, refused unless the adapter vouches for them.
/// The claims start the work; `MirrorSwitch` is the last step before a mirror is deleted.
pub(crate) fn refuses(op: StoreOp) -> bool {
    matches!(
        op,
        StoreOp::Repo(
            R::Delete
                | R::PurgeTarget
                | R::EraseStep
                | R::ReleaseDelete
                | R::ChangeDelete
                | R::AuditSetAside
        ) | StoreOp::Maintenance(M::VacuumPlan)
            | StoreOp::Quarantine(Q::Purge | Q::Claim | Q::MirrorClaim | Q::MirrorSwitch)
    )
}

pub(crate) fn refusal() -> Error {
    Error::new(
        "LEGAL_HOLD",
        "This repository is under a legal hold: nothing in it can be deleted until the hold \
         is released",
    )
}

/// Refuses unless `_hold` is a verified answer that says free. `HOLD_UNCHECKED`'s message is
/// `owner`, the account the adapter asks (empty on a commit shard, which has none to name).
pub(crate) fn require_free(c: &Value, owner: &str) -> Result<()> {
    if c["_hold"] == "off" {
        return Ok(());
    }
    match c["_hold"]["held"].as_bool() {
        Some(false) => Ok(()),
        Some(true) => Err(refusal()),
        None => Err(Error::new("HOLD_UNCHECKED", owner)),
    }
}
