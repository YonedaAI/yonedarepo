//! The repository authority's commands. `repo_init` creates the store, so it runs before
//! there are settings to authorize against; every other op is a [`StoreOp`], authorized by
//! `authorize` and run by `run`, each an exhaustive match.
use crate::ops::op_names;
use crate::storage::string;
use serde::Deserialize;
use serde_json::Value;
use yoneda_core::{Error, Result};

op_names! {
    pub(crate) enum InitOp {
        Init = "repo_init",
    }
}
op_names! {
    /// Commands the repository store runs itself.
    pub(crate) enum RepoOp {
        Activity = "repo_activity",
        AdoptCommit = "repo_adopt_commit",
        AgentContext = "repo_agent_context",
        BeginCommit = "repo_begin_commit",
        BisectList = "repo_bisect_list",
        BisectStart = "repo_bisect_start",
        BisectStep = "repo_bisect_step",
        BranchBatch = "repo_branch_batch",
        BranchSet = "repo_branch_set",
        BreakGlass = "repo_break_glass",
        BundleIndex = "repo_bundle_index",
        BundleLocate = "repo_bundle_locate",
        ChangeClose = "repo_change_close",
        ChangeComment = "repo_change_comment",
        ChangeCreate = "repo_change_create",
        ChangeDelete = "repo_change_delete",
        ChangeRecords = "repo_change_records",
        ChangeReopen = "repo_change_reopen",
        ChangeShow = "repo_change_show",
        Changes = "repo_changes",
        ChangesetPlan = "repo_changeset_plan",
        ChangesetRecord = "repo_changeset_record",
        Check = "repo_check",
        CheckClaim = "repo_check_claim",
        CheckComplete = "repo_check_complete",
        CheckRelease = "repo_check_release",
        CheckRequest = "repo_check_request",
        CheckRun = "repo_check_run",
        CloneAccess = "repo_clone_access",
        Commit = "repo_commit",
        ContractList = "repo_contract_list",
        Contracts = "repo_contracts",
        Delete = "repo_delete",
        GitAccess = "repo_git_access",
        GitWalk = "repo_git_walk",
        Head = "repo_head",
        HookClaim = "repo_hook_claim",
        HookCreate = "repo_hook_create",
        HookDelete = "repo_hook_delete",
        HookDeliveries = "repo_hook_deliveries",
        HookSettle = "repo_hook_settle",
        Hooks = "repo_hooks",
        HooksFanout = "repo_hooks_fanout",
        Import = "repo_import",
        Land = "repo_land",
        LandBatch = "repo_land_batch",
        LandChangesets = "repo_land_changesets",
        LandClaim = "repo_land_claim",
        LandEnqueue = "repo_land_enqueue",
        LandRelease = "repo_land_release",
        LandStatus = "repo_land_status",
        LandSubmitted = "repo_land_submitted",
        Log = "repo_log",
        MemberPut = "repo_member_put",
        MemberRemove = "repo_member_remove",
        Members = "repo_members",
        MergeBase = "repo_merge_base",
        MergePlan = "repo_merge_plan",
        ObjectsPending = "repo_objects_pending",
        ObjectsProjected = "repo_objects_projected",
        ObjectsStored = "repo_objects_stored",
        PathHistory = "repo_path_history",
        PinList = "repo_pin_list",
        PrepareCommit = "repo_prepare_commit",
        ProjectionObjects = "repo_projection_objects",
        ProjectionPending = "repo_projection_pending",
        ProjectionResult = "repo_projection_result",
        PurgeTarget = "repo_purge_target",
        RebasePlan = "repo_rebase_plan",
        RecordClasses = "repo_record_classes",
        RecordCommit = "repo_record_commit",
        RecordContract = "repo_record_contract",
        RecordImported = "repo_record_imported",
        RecordPushed = "repo_record_pushed",
        RecordRepair = "repo_record_repair",
        RecordSymbols = "repo_record_symbols",
        Refs = "repo_refs",
        ReleaseAsset = "repo_release_asset",
        ReleaseAssetPut = "repo_release_asset_put",
        ReleaseCreate = "repo_release_create",
        ReleaseDelete = "repo_release_delete",
        ReleaseShow = "repo_release_show",
        Releases = "repo_releases",
        Review = "repo_review",
        SessionList = "repo_session_list",
        SessionRecord = "repo_session_record",
        SessionShow = "repo_session_show",
        SessionTranscript = "repo_session_transcript",
        Sessions = "repo_sessions",
        SetPolicy = "repo_set_policy",
        SetVisibility = "repo_set_visibility",
        Snapshot = "repo_snapshot",
        StagedObjects = "repo_staged_objects",
        StaleReads = "repo_stale_reads",
        Status = "repo_status",
        TagCreate = "repo_tag_create",
        TagShow = "repo_tag_show",
        TokenCreate = "repo_token_create",
        TokenRevoke = "repo_token_revoke",
        Tokens = "repo_tokens",
        Txlog = "repo_txlog",
    }
}
op_names! {
    /// Retention: pins, vacuum and compaction (`maintenance`).
    pub(crate) enum MaintenanceOp {
        Pin = "repo_pin",
        VacuumPlan = "repo_vacuum_plan",
        VacuumDone = "repo_vacuum_done",
        CompactPlan = "repo_compact_plan",
        CompactDone = "repo_compact_done",
        SetRetention = "repo_set_retention",
    }
}
op_names! {
    /// Git LFS objects (`lfs`).
    pub(crate) enum LfsOp {
        Batch = "repo_lfs_batch",
        Store = "repo_lfs_store",
        Discard = "repo_lfs_discard",
        Usage = "repo_lfs_usage",
        SetQuota = "repo_lfs_set_quota",
        SweepClaim = "repo_lfs_sweep_claim",
        SweepDone = "repo_lfs_sweep_done",
    }
}
op_names! {
    /// Forking and carrying changes between a fork and its parent (`forks`).
    pub(crate) enum ForkOp {
        Source = "repo_fork_source",
        Export = "repo_fork_export",
        Offer = "repo_fork_offer",
        Record = "repo_fork_record",
        Refs = "repo_fork_refs",
        Register = "repo_fork_register",
        Forget = "repo_fork_forget",
        Branch = "repo_fork_branch",
        Mirror = "repo_fork_mirror",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub(crate) enum Op {
    Init(InitOp),
    Store(StoreOp),
}

/// Every op of an initialized store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub(crate) enum StoreOp {
    Repo(RepoOp),
    Maintenance(MaintenanceOp),
    Lfs(LfsOp),
    Fork(ForkOp),
}

impl Op {
    /// The command's `op`; a name no family knows is `UNKNOWN_OP`.
    pub(crate) fn parse(command: &Value) -> Result<Self> {
        let name = string(command, "op")?;
        Self::deserialize(&command["op"])
            .map_err(|_| Error::new("UNKNOWN_OP", format!("Unknown platform op {name}")))
    }

    #[cfg(test)]
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Init(op) => op.name(),
            Self::Store(op) => op.name(),
        }
    }

    #[cfg(test)]
    pub(crate) fn all() -> Vec<Self> {
        let store = RepoOp::ALL.iter().copied().map(StoreOp::Repo);
        let store = store.chain(MaintenanceOp::ALL.iter().copied().map(StoreOp::Maintenance));
        let store = store.chain(LfsOp::ALL.iter().copied().map(StoreOp::Lfs));
        let store = store.chain(ForkOp::ALL.iter().copied().map(StoreOp::Fork));
        let init = InitOp::ALL.iter().copied().map(Self::Init);
        init.chain(store.map(Self::Store)).collect()
    }
}

impl StoreOp {
    #[cfg(test)]
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Repo(op) => op.name(),
            Self::Maintenance(op) => op.name(),
            Self::Lfs(op) => op.name(),
            Self::Fork(op) => op.name(),
        }
    }
}
