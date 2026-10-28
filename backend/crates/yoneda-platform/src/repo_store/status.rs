//! `repo_status` as a typed contract: what `GET /repos/:id` answers. Its JSON Schema
//! generates `shared/contracts/repo-status.ts` (`cargo xtask contracts`).
use super::auth::Actor;
use super::members::Role;
use super::rows::{self, Policy, Settings};
use crate::storage::SqlStore;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use yoneda_core::Result;

/// The repository's name, log version, policy, refs and the caller's access.
#[derive(Debug, Serialize, JsonSchema)]
pub struct RepoStatus {
    pub name: String,
    pub version: u64,
    pub owner: String,
    pub object_store: String,
    pub policy: Policy,
    pub policy_digest: String,
    pub refs: Vec<RefHead>,
    pub projections: Vec<Projection>,
    /// Object projection progress (the adapter merges shard outboxes into it).
    pub objects: Value,
    /// Whether any pushed bundle still waits to be unpacked.
    pub bundled: bool,
    /// Whether automation is paused, and by whom.
    pub automation: Value,
    /// Set on a fork: the repository it was forked from and that one's version at the fork.
    pub parent: Option<ForkParent>,
    /// How many forks read this repository's objects (it is deleted only after them).
    pub forks: u64,
    pub viewer: Viewer,
    /// The paths a path-scoped token may read (null: the whole repository).
    pub grant: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RefHead {
    pub name: String,
    pub commit_id: String,
    pub version: u64,
}

/// A ref's Git projection: the target the log decided and how far Git has caught up.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct Projection {
    pub refname: String,
    pub target_commit: String,
    pub target_version: u64,
    pub projected_commit: Option<String>,
    pub projected_version: u64,
    pub status: ProjectionStatus,
    pub detail: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProjectionStatus {
    /// The target waits for Git to catch up.
    Pending,
    Ok,
    /// Git moved elsewhere; an owner resolves it.
    Drift,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ForkParent {
    pub repo: String,
    pub version: u64,
}

/// Who is asking: the owner, or a member's role (null: neither).
#[derive(Debug, Serialize, JsonSchema)]
pub struct Viewer {
    pub principal: String,
    pub owner: bool,
    pub role: Option<Role>,
}

fn typed<T: serde::de::DeserializeOwned>(rows: Vec<Value>, table: &str) -> Result<Vec<T>> {
    rows.into_iter()
        .map(|row| serde_json::from_value(row).map_err(|_| rows::corrupt(table)))
        .collect()
}

/// The repository's status, with who is asking (`viewer`).
pub fn status<S: SqlStore>(db: &S, settings: &Settings, actor: &Actor) -> Result<RepoStatus> {
    let refs = db.query(
        "SELECT name,commit_id AS commit_id,version FROM refs ORDER BY name",
        &[],
    )?;
    Ok(RepoStatus {
        name: settings.name.clone(),
        version: rows::current_version(db)?,
        owner: settings.owner.clone(),
        object_store: settings.object_store.clone(),
        policy: settings.policy.clone(),
        policy_digest: settings.policy_digest.clone(),
        refs: typed(refs, "refs")?,
        projections: typed(super::projection::list(db)?, "ref_projections")?,
        objects: super::staging::status(db)?,
        bundled: super::pushed::bundles::any(db)?,
        automation: super::break_glass::state(db)?,
        parent: settings.parent.as_ref().map(|(repo, version)| ForkParent {
            repo: repo.clone(),
            version: *version,
        }),
        forks: super::forks::count(db)?,
        viewer: Viewer {
            principal: actor.principal.clone(),
            owner: actor.owner,
            role: actor.member,
        },
        grant: actor.grant.clone(),
    })
}
