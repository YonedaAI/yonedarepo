//! `--json` results of the commands about this machine and its checkouts: login, agent
//! setup, declared reads, conflicts, context, and the offline checkout commands (`clone`,
//! `status`, `pull`, `sync`).
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `login`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Login {
    pub origin: String,
    /// The signed-in account, when the platform names it (device login).
    pub account: Option<String>,
    pub expires_at: Option<String>,
    /// The credentials file the token was stored in (mode 0600).
    pub credentials: String,
}

/// `logout`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Logout {
    /// Whether a stored token was removed.
    pub removed: bool,
    pub credentials: String,
}

/// `setup <agent>`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    pub agent: String,
    /// Files written.
    pub written: Vec<String>,
    pub mcp_url: String,
    /// The environment variable the agent reads the token from.
    pub token_env: String,
}

/// `reads add`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadsAdd {
    /// Paths newly declared.
    pub added: u64,
    /// Paths declared in all.
    pub total: u64,
}

/// `reads list`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadsList {
    /// The declared reads (repository-relative paths; a trailing `/` is a directory).
    pub reads: Vec<String>,
}

/// `reads clear`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadsClear {
    /// Declared reads removed.
    pub cleared: u64,
}

/// `conflicts`: the last landing the remote helper saw refused in this clone.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Conflicts {
    /// Whether a refused landing is recorded.
    pub refused: bool,
    pub message: Option<String>,
    pub paths: Vec<String>,
}

/// `context`: what a coding session starting in this clone should know.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Context {
    /// This clone's one-line status (`status --brief`), if it could be made.
    pub brief: Option<String>,
    /// The checked-out branch.
    pub branch: Option<String>,
    /// The platform's context read (`GET /context`), unchanged.
    pub context: Value,
}

/// How `clone` brought the repository in.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CloneMethod {
    /// `git clone` with a short-lived read token.
    GitClone,
    /// A snapshot of the branch through the API.
    ApiSnapshot,
}

/// `clone` (an offline checkout).
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Cloned {
    pub repo: String,
    pub dir: String,
    /// The log version the checkout is pinned to.
    pub version: u64,
    pub method: CloneMethod,
}

/// The last landing from an offline checkout.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LastLand {
    pub version: u64,
    /// Its Git commit, null until projected.
    pub git_commit: Option<String>,
}

/// The branch's object store projection.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Projection {
    pub projected_version: u64,
    pub target_version: u64,
    pub status: String,
}

/// What the platform says about an offline checkout's branch.
#[derive(Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RemoteStatus {
    /// Null when the platform answered; else why not (`unreachable`, or its error).
    pub error: Option<String>,
    /// The repository's log version.
    pub version: Option<u64>,
    /// Versions after the checkout's base.
    pub behind: Option<u64>,
    /// The version the branch's Git commit is projected at.
    pub projected_version: Option<u64>,
    /// Changesets landed after that version still without a Git commit (of the first 500).
    pub awaiting_git_commit: Option<u64>,
    pub store: Option<Projection>,
}

/// `status`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Status {
    /// A Git clone with a yoneda remote.
    Clone {
        repo: String,
        origin: String,
        branch: String,
        /// Local commits on the branch the platform does not have (`200+` past 200).
        unpushed: String,
        /// The last landing through the remote helper was refused (see `conflicts`).
        landing_refused: bool,
    },
    /// An offline checkout (`yoneda clone`); `--brief` leaves out the counts and remote.
    Checkout {
        repo: String,
        origin: String,
        branch: String,
        base_version: u64,
        base_commit: String,
        offline_branch: String,
        /// Local commits since the base.
        pending: Option<u64>,
        /// Of those, pushed to the offline branch.
        pushed: Option<u64>,
        last_land: Option<LastLand>,
        remote: Option<Box<RemoteStatus>>,
    },
}

/// What `pull` did.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PullOutcome {
    UpToDate,
    FastForwarded,
    /// Pending local commits were rebased onto the new base.
    Rebased,
}

/// `pull`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Pull {
    pub branch: String,
    pub version: u64,
    pub outcome: PullOutcome,
    /// Commits rebased (0 unless `rebased`).
    pub rebased: u64,
}

/// A local commit contributed through an MCP attempt.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AttemptCommit {
    pub local: String,
    pub commit: String,
}

/// The landing `sync --land` made.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SyncLanding {
    /// Local commits landed (0: nothing to land).
    pub commits: u64,
    pub branch: String,
    pub version: Option<u64>,
    /// The landing's Git commit, null until projected.
    pub git_commit: Option<String>,
    /// Whether HEAD moved to the landed snapshot (else `git merge --ff-only` it).
    pub fast_forwarded: bool,
}

/// `sync`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum Synced {
    /// `sync` (and the push half of `sync --land`).
    Push {
        /// Platform commits made or adopted.
        pushed: u64,
        /// Of those, adopted from an interrupted earlier sync.
        adopted: u64,
        offline_branch: String,
        /// The landing, with `--land`.
        landing: Option<SyncLanding>,
    },
    /// `sync --attempt <id>`.
    Attempt {
        attempt: String,
        committed: Vec<AttemptCommit>,
        /// The attempt's status after submitting.
        status: String,
    },
}

super::report! {
    Login => "login",
    Logout => "logout",
    Setup => "setup",
    ReadsAdd => "reads-add",
    ReadsList => "reads-list",
    ReadsClear => "reads-clear",
    Conflicts => "conflicts",
    Context => "context",
    Cloned => "clone",
    Status => "status",
    Pull => "pull",
    Synced => "sync",
}
