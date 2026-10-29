//! `--json` results of the repository commands: tokens, checks, landing, reviews, policy,
//! change requests, releases and session records. Where the human mode prints a platform
//! record as it comes (a check run, the policy, a change), the document carries that
//! record unchanged; its shape is the platform API's.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `token create`: the secret is shown once.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TokenCreate {
    pub repo: String,
    pub name: String,
    pub token: String,
}

/// `token list`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TokenList {
    /// The platform's token records (never the secrets).
    pub tokens: Vec<Value>,
}

/// `token revoke`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TokenRevoke {
    pub repo: String,
    pub name: String,
}

/// `check run`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CheckRun {
    pub commit: String,
    /// The queued check run, as the platform records it.
    pub run: Value,
}

/// `check status`: one check run, or a commit's checks and gates.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CheckStatus {
    /// `check status <run>`.
    Run {
        /// The check run, as the platform records it.
        run: Value,
    },
    /// `check status [--commit <sha>]`.
    Commit {
        commit: String,
        /// Reported check results by name.
        checks: Value,
        check_runs: Value,
        /// Whether the commit may land, and why not.
        gates: Value,
    },
}

/// A landing on a branch.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Land {
    /// The branch landed.
    pub branch: String,
    /// The commit landed.
    pub head: String,
    /// The branch landed on.
    pub base: String,
    /// The log version of the landing.
    pub version: Option<u64>,
    /// Whether the platform merged it onto a moved base (else it fast-forwarded).
    pub merged: bool,
}

/// `change land`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeLand {
    pub number: u64,
    pub head: String,
    pub base: String,
    pub version: Option<u64>,
    pub merged: bool,
}

/// `rebase`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Rebase {
    pub branch: String,
    pub onto: String,
    /// The branch was on `onto` already; nothing moved.
    pub up_to_date: bool,
    /// Commits replayed.
    pub replayed: u64,
    /// The branch's new head (null when up to date).
    pub head: Option<String>,
}

/// An approval or a rejection.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approve,
    Reject,
}

/// `review`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub commit: String,
    pub decision: Decision,
}

/// `policy show`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyShow {
    /// The landing policy (approvals, required checks, path rules), as the platform holds it.
    pub policy: Value,
}

/// `policy set`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicySet {
    /// The platform's answer: the policy now in force.
    pub result: Value,
}

/// A change request in one line.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeSummary {
    pub number: u64,
    /// `open`, `landed` or `closed`.
    pub status: String,
    pub title: String,
    pub branch: String,
    pub base: String,
    pub author: String,
    /// The branch's current commit (null once the branch is gone).
    pub head: Option<String>,
}

/// `change create`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeCreate {
    /// The repository it was opened on (a fork's parent with `--to-parent`).
    pub repo: String,
    pub change: ChangeSummary,
}

/// `change list`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeList {
    /// The status listed.
    pub status: String,
    pub changes: Vec<ChangeSummary>,
}

/// `change show`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeShow {
    /// The change with its gates, reviews, diff and comments, as the platform returns it.
    pub change: Value,
}

/// `change comment`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeComment {
    pub number: u64,
    /// Whether a comment was posted (`--resolve` alone posts none).
    pub commented: bool,
    /// Comments resolved (with `--resolve`).
    pub resolved: u64,
}

/// A release in one line.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReleaseSummary {
    pub tag: String,
    pub title: String,
    pub commit_id: String,
    pub created_by: String,
    pub asset_count: u64,
}

/// A release asset.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

/// `release create`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReleaseCreate {
    pub release: ReleaseSummary,
    /// The asset uploaded with `--asset`.
    pub asset: Option<Asset>,
}

/// `release list`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReleaseList {
    pub releases: Vec<ReleaseSummary>,
}

/// `release show`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReleaseShow {
    /// The release with its notes, tag and assets, as the platform returns it.
    pub release: Value,
}

/// `session record`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionRecord {
    pub commit: String,
    /// The platform's id for the record.
    pub session: Value,
}

/// A coding session recorded on a commit.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub cli: String,
    pub model: Option<String>,
    pub recorded_by: String,
    pub summary: String,
}

/// `session list`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionList {
    pub commit: String,
    pub sessions: Vec<Session>,
}

/// `memory add`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryAdd {
    /// The memory's id.
    pub memory: Value,
    /// The commit it was written against.
    pub commit: String,
    /// Whether the same memory was recorded already (this answers that one).
    pub already: bool,
}

/// `memory list`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryList {
    /// The memories newest first, as the platform returns them (with anchors and staleness).
    pub memories: Vec<Value>,
    /// The `before` cursor of the next page, when more remain.
    pub next: Value,
}

/// `memory show`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryShow {
    /// The memory as the platform returns it.
    pub memory: Value,
}

/// `memory retire`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryRetire {
    pub memory: u64,
    /// Whether it was retired already.
    pub already: bool,
}

super::report! {
    MemoryAdd => "memory-add",
    MemoryList => "memory-list",
    MemoryShow => "memory-show",
    MemoryRetire => "memory-retire",
    TokenCreate => "token-create",
    TokenList => "token-list",
    TokenRevoke => "token-revoke",
    CheckRun => "check-run",
    CheckStatus => "check-status",
    Land => "land",
    ChangeLand => "change-land",
    Rebase => "rebase",
    Review => "review",
    PolicyShow => "policy-show",
    PolicySet => "policy-set",
    ChangeCreate => "change-create",
    ChangeList => "change-list",
    ChangeShow => "change-show",
    ChangeComment => "change-comment",
    ReleaseCreate => "release-create",
    ReleaseList => "release-list",
    ReleaseShow => "release-show",
    SessionRecord => "session-record",
    SessionList => "session-list",
}
