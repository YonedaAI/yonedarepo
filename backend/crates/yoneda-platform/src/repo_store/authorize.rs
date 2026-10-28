//! Who may run each repository op: the scope, role or platform identity it needs. Families
//! with their own rules (`maintenance`, `lfs`, `forks`) decide for their ops.
use super::auth::Actor;
use super::op::{RepoOp as R, StoreOp};
use super::{forks, land, lfs, maintenance, rows, tags};
use serde_json::Value;
use yoneda_core::{Error, Result};

pub(super) fn authorize(actor: &Actor, op: StoreOp, c: &Value) -> Result<()> {
    let op = match op {
        StoreOp::Maintenance(op) => return maintenance::authorize(actor, op),
        StoreOp::Lfs(op) => return lfs::authorize(actor, op, c),
        StoreOp::Fork(op) => return forks::authorize(actor, op),
        StoreOp::Repo(op) => op,
    };
    match op {
        // Tags are release markers that never move: creating one needs `land` as well.
        R::TagCreate => actor.require("write").and_then(|()| actor.require("land")),
        R::BranchBatch if tags::in_batch(c) => {
            actor.require("write").and_then(|()| actor.require("land"))
        }
        // Releases publish a tag the way tags mark one: `land` as well as `write`.
        R::ReleaseCreate | R::ReleaseDelete | R::ReleaseAssetPut => {
            actor.require("write").and_then(|()| actor.require("land"))
        }
        R::PrepareCommit
        | R::RecordCommit
        | R::RebasePlan
        | R::BranchSet
        | R::BranchBatch
        | R::BeginCommit => actor.require("write"),
        // Owner (or repo:admin) checks and the purger's check happen in `deletion`.
        R::Delete | R::PurgeTarget => Ok(()),
        // Only the platform copies commit shard records in.
        R::AdoptCommit if !actor.can("system") => {
            Err(Error::new("FORBIDDEN", "Only the platform adopts commits"))
        }
        R::Check => actor.require("check"),
        R::SessionRecord => actor.require("write"),
        // A change from a fork proposes the parent's mirror of a fork branch (`forks`):
        // the fork's writer needs only read here.
        R::ChangeCreate if c["source_repo"].is_string() => actor.require("read"),
        R::ChangeCreate | R::ChangeClose | R::ChangeReopen => actor.require("write"),
        // Reviewers discuss a change as well as writers.
        R::ChangeComment => actor.require_any(&["write", "review"]),
        R::CheckRequest | R::BisectStart => actor.require_any(&["write", "check"]),
        // The check executor advances bisects as results arrive.
        R::BisectStep => actor.require_any(&["write", "check", "system"]),
        R::RecordContract => actor.require("write"),
        // Only the platform classifier records review classes.
        R::RecordClasses | R::RecordSymbols if !actor.can("classify") => Err(Error::new(
            "FORBIDDEN",
            "Only the platform classifier records derived classes",
        )),
        // Change records feed analytics; only the platform's derive job streams them.
        R::ChangeRecords if !actor.can("classify") => Err(Error::new(
            "FORBIDDEN",
            "Only the platform reads change records",
        )),
        R::CheckClaim
        | R::CheckRelease
        | R::CheckComplete
        | R::ProjectionPending
        | R::ProjectionResult
        | R::ChangesetPlan
        | R::Head
        | R::ChangesetRecord
        | R::RecordRepair => actor.require("system"),
        // Only the platform's object projector reads or settles the object outbox: a false
        // "projected" would drop the only copy of accepted objects.
        R::ObjectsPending
        | R::ObjectsProjected
        | R::StagedObjects
        | R::ProjectionObjects
        | R::ObjectsStored
            if !actor.can("system") =>
        {
            Err(Error::new(
                "FORBIDDEN",
                "Only the platform projects staged objects",
            ))
        }
        // Imported history is only recorded by the platform importer, which read it from
        // the object store; nobody else can declare commits into existence.
        R::RecordImported if !actor.can("import") => Err(Error::new(
            "FORBIDDEN",
            "Only the platform importer records imported history",
        )),
        R::Review => actor.require("review"),
        // Protected refs need `land`; any other branch lands with `write` (`land::scope`).
        R::Land | R::LandEnqueue => actor.require(land::scope(&rows::branch_ref(c)?)),
        // Only the platform merger builds and lands batches.
        R::LandClaim | R::LandBatch | R::LandRelease | R::LandChangesets | R::LandSubmitted
            if !actor.can("lander") =>
        {
            Err(Error::new(
                "FORBIDDEN",
                "Only the platform merger lands queued work",
            ))
        }
        R::SetPolicy => actor.require_owner(),
        // Admins manage other members; only the owner manages admins (`members`).
        R::Members | R::MemberPut | R::MemberRemove => actor.require_owner(),
        // Hooks reveal repository events to an outside URL: the owner (or repo:admin) decides.
        R::HookCreate | R::Hooks | R::HookDelete | R::HookDeliveries => actor.require_owner(),
        // Only the platform's hook job fans out, reads secrets and settles deliveries.
        R::HooksFanout | R::HookClaim | R::HookSettle if !actor.can("hooks") => {
            Err(Error::new("FORBIDDEN", "Only the platform delivers hooks"))
        }
        R::BreakGlass => actor.require_human_owner(),
        R::CloneAccess => actor.require_human_reader(),
        // Every other op, and a guarded op above whose caller passes its guard, reads.
        R::AdoptCommit
        | R::AgentContext
        | R::BisectList
        | R::BundleIndex
        | R::BundleLocate
        | R::ChangeRecords
        | R::ChangeShow
        | R::Changes
        | R::CheckRun
        | R::Commit
        | R::ContractList
        | R::Contracts
        | R::GitAccess
        | R::GitWalk
        | R::HookClaim
        | R::HookSettle
        | R::HooksFanout
        | R::Import
        | R::LandBatch
        | R::LandChangesets
        | R::LandClaim
        | R::LandRelease
        | R::LandStatus
        | R::LandSubmitted
        | R::Log
        | R::MergeBase
        | R::MergePlan
        | R::ObjectsPending
        | R::ObjectsProjected
        | R::ObjectsStored
        | R::PathHistory
        | R::PinList
        | R::ProjectionObjects
        | R::RecordClasses
        | R::RecordImported
        | R::RecordPushed
        | R::RecordSymbols
        | R::Refs
        | R::ReleaseAsset
        | R::ReleaseShow
        | R::Releases
        | R::SessionList
        | R::SessionShow
        | R::Sessions
        | R::Snapshot
        | R::StagedObjects
        | R::StaleReads
        | R::Status
        | R::TagShow
        | R::TokenCreate
        | R::TokenRevoke
        | R::Tokens
        | R::Txlog => actor.require("read"),
    }
}
