//! `repo_status` as a typed contract, and what `GET /repos/:id` answers: that status with the
//! readable path the Worker adds. The answer's JSON Schema generates
//! `shared/contracts/repo-status.ts` (`cargo xtask contracts`).
use super::auth::Actor;
use super::members::Role;
use super::rows::{self, AutoLandings, Policy, Settings, Visibility};
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
    /// Identity of this version's history, including after an operator re-import reuses
    /// version numbers. None before the first transaction-log entry.
    pub history_chain: Option<String>,
    pub owner: String,
    pub object_store: String,
    pub policy: Policy,
    pub policy_digest: String,
    pub refs: Vec<RefHead>,
    /// Object projection progress (the adapter merges shard outboxes into it).
    pub objects: Value,
    /// Whether any pushed bundle still waits to be unpacked.
    pub bundled: bool,
    /// Whether automation is paused, and by whom.
    pub automation: Value,
    /// Whether a push opens a Landing, and whether agents run on those.
    pub landings: AutoLandings,
    /// Set on a fork: the repository it was forked from and that one's version at the fork.
    pub parent: Option<ForkParent>,
    /// How many forks read this repository's objects (it is deleted only after them).
    pub forks: u64,
    /// Who may read: members only, or anyone.
    pub visibility: Visibility,
    pub viewer: Viewer,
    /// The paths a path-scoped token may read (null: the whole repository).
    pub grant: Option<Vec<String>>,
    /// Blobs no read serves (quarantined or purged); trees still name them.
    pub quarantined: Vec<Withheld>,
    /// Changes whenever `quarantined` does: caches derived from content are keyed by it.
    pub quarantine_epoch: u64,
    /// Optional internal read selection, requested with status and stripped by the adapter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<RepoSnapshot>,
}

/// A current branch selection made in the same transaction as fresh read admission.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RepoSnapshot {
    pub version: u64,
    #[serde(rename = "ref")]
    pub refname: String,
    pub commit: String,
    pub tree: String,
    pub parents: Vec<String>,
}

/// What `GET /repos/:id` answers: the repository's status with its readable path. The Worker
/// adds both from the D1 listing (cloudflare/worker/repo-paths.ts): the repository does not
/// know its owner's handle.
#[derive(Debug, Serialize, JsonSchema)]
#[schemars(rename = "RepoStatus")]
pub struct RepoAnswer {
    #[serde(flatten)]
    pub status: RepoStatus,
    /// The owner's handle (null while an email-named owner has none).
    pub owner_handle: Option<String>,
    /// The readable path `/<handle>/<name>` (null while the owner has no handle).
    pub path: Option<String>,
}

/// A withheld blob and the path its owner named when quarantining it.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct Withheld {
    pub id: String,
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RefHead {
    pub name: String,
    pub commit_id: String,
    pub version: u64,
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
    /// Reading a public repository as neither owner nor member.
    pub public: bool,
}

fn typed<T: serde::de::DeserializeOwned>(rows: Vec<Value>, table: &str) -> Result<Vec<T>> {
    rows.into_iter()
        .map(|row| serde_json::from_value(row).map_err(|_| rows::corrupt(table)))
        .collect()
}

/// The repository's status, with who is asking (`viewer`).
pub fn status<S: SqlStore>(
    db: &S,
    c: &Value,
    settings: &Settings,
    actor: &Actor,
) -> Result<RepoStatus> {
    let history = db.query(
        "SELECT version,chain FROM txlog ORDER BY version DESC LIMIT 1",
        &[],
    )?;
    let refs = db.query(
        "SELECT name,commit_id AS commit_id,version FROM refs ORDER BY name",
        &[],
    )?;
    let mut status = RepoStatus {
        name: settings.name.clone(),
        version: history
            .first()
            .and_then(|row| row["version"].as_u64())
            .unwrap_or(0),
        history_chain: history
            .first()
            .map(|row| {
                row["chain"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| rows::corrupt("log chain"))
            })
            .transpose()?,
        owner: settings.owner.clone(),
        object_store: settings.object_store.clone(),
        policy: settings.policy.clone(),
        policy_digest: settings.policy_digest.clone(),
        refs: typed(refs, "refs")?,
        objects: super::staging::status(db)?,
        bundled: super::pushed::bundles::any(db)?,
        automation: super::break_glass::state(db)?,
        landings: settings.auto_landings,
        parent: settings.parent.as_ref().map(|(repo, version)| ForkParent {
            repo: repo.clone(),
            version: *version,
        }),
        forks: super::forks::count(db)?,
        visibility: settings.visibility,
        viewer: Viewer {
            principal: actor.principal.clone(),
            owner: actor.owner,
            role: actor.member,
            public: actor.public,
        },
        grant: actor.grant.clone(),
        // A path-restricted caller learns which ids are withheld, never paths outside it.
        quarantined: typed::<Withheld>(super::quarantine::withheld(db)?, "quarantine")?
            .into_iter()
            .map(|w| Withheld {
                path: w.path.filter(|p| super::grants::allows(&actor.grant, p)),
                ..w
            })
            .collect(),
        quarantine_epoch: super::quarantine::epoch(db)?,
        snapshot: None,
    };
    status.snapshot = selected_snapshot(db, c, &status);
    Ok(status)
}

fn selected_snapshot<S: SqlStore>(db: &S, c: &Value, status: &RepoStatus) -> Option<RepoSnapshot> {
    let request = c.get("snapshot").filter(|v| v.is_object())?;
    if status.parent.is_some()
        || status.grant.is_some()
        || request.get("at").is_some()
        || c.get("at").is_some()
        || request
            .get("min_version")
            .is_some_and(|v| v.as_u64().is_none_or(|minimum| minimum > status.version))
    {
        return None;
    }
    // Reuse snapshot's current-ref rules, including PROJECTION_PENDING. A hint is
    // best effort: an absent/failed selection leaves the adapter's existing read and
    // retry/archive behavior in charge, without changing the successful status reply.
    let value = super::reads::snapshot(db, &serde_json::json!({"ref": request["ref"]})).ok()?;
    let selected: RepoSnapshot = serde_json::from_value(value).ok()?;
    (selected.version == status.version).then_some(selected)
}
