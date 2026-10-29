//! Public and private repositories. A private repository (the default) exists only for its
//! owner and members: everyone else, with or without credentials, is told NOT_FOUND, so its
//! existence does not leak. A public one is read by anyone: a caller without credentials
//! (`_anonymous`, set by the adapter) or an account that is not a member acts as a *public
//! reader*, which holds `read` over the whole repository and runs only the reads listed
//! here. Members, tokens and path-restricted grants act exactly as on a private repository,
//! so publishing grants nobody write and lifts no token's restriction. Only the owner's
//! account (or an owner of the owning organization) changes visibility.
use super::auth::Actor;
use super::op::{ForkOp, LfsOp, RepoOp as R, StoreOp};
use crate::storage::{SqlStore, bad, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    Private,
    Public,
}

impl Visibility {
    pub fn parse(text: &str) -> Result<Self> {
        match text {
            "private" => Ok(Self::Private),
            "public" => Ok(Self::Public),
            _ => Err(bad("visibility must be private or public")),
        }
    }
    /// `visibility` from a command, `Private` when it is absent.
    pub fn from_command(c: &Value) -> Result<Self> {
        match &c["visibility"] {
            Value::Null => Ok(Self::Private),
            Value::String(text) => Self::parse(text),
            _ => Err(bad("visibility must be private or public")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Public => "public",
        }
    }
}

/// What a public reader may run: reads of code, history, changes, releases, agent records,
/// LFS downloads, Git fetches (served from the authority's refs) and the parent's side of
/// forking. Everything else (writes, settings, tokens, members, hooks, policy, and direct
/// object-store credentials through `repo_clone_access`) stays with owners and members,
/// even where the operation itself would accept `read`.
fn public_read(op: StoreOp) -> bool {
    matches!(
        op,
        StoreOp::Repo(
            R::Status
                | R::Refs
                | R::Snapshot
                | R::Log
                | R::Txlog
                | R::Commit
                | R::MergeBase
                | R::PathHistory
                | R::Contracts
                | R::ContractList
                | R::Sessions
                | R::SessionList
                | R::SessionShow
                | R::SessionTranscript
                | R::PinList
                | R::BisectList
                | R::AgentContext
                | R::Changes
                | R::ChangeShow
                | R::CheckRun
                | R::TagShow
                | R::Releases
                | R::ReleaseShow
                | R::ReleaseAsset
                | R::LandStatus
                | R::GitAccess
                | R::GitWalk
                | R::BundleLocate
        ) | StoreOp::Lfs(LfsOp::Batch)
            | StoreOp::Fork(ForkOp::Source | ForkOp::Export)
    )
}

/// Refuses a public reader anything but `public_read` (the per-operation scope checks
/// still apply): a caller without credentials is asked to sign in, an account that is not
/// a member is refused.
pub fn gate(actor: &Actor, op: StoreOp, c: &Value) -> Result<()> {
    // A push and an LFS upload ask through read operations, but they are writes.
    let writes = match op {
        StoreOp::Repo(R::GitAccess) => c["service"] != "git-upload-pack",
        StoreOp::Lfs(LfsOp::Batch) => c["operation"] != "download",
        _ => false,
    };
    if !actor.public || (public_read(op) && !writes) {
        return Ok(());
    }
    Err(if actor.anonymous() {
        Error::new(
            "UNAUTHORIZED",
            "Sign in to do more than read this public repository",
        )
    } else {
        Error::new(
            "FORBIDDEN",
            "This public repository is read-only for accounts that are not members",
        )
    })
}

/// `repo_set_visibility {visibility}`: the owner's account only (never an admin member or a
/// token). The adapter republishes the head before answering, so a repository made private
/// stops serving public readers everywhere within the access bound.
pub fn set<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    actor.require_repo_owner()?;
    let next = Visibility::parse(&string(c, "visibility")?)?;
    let changed = db.query(
        "UPDATE repo_settings SET visibility=? WHERE id='repository' AND visibility<>? RETURNING id",
        &[json!(next.as_str()), json!(next.as_str())],
    )?;
    Ok(json!({ "visibility": next.as_str(), "changed": !changed.is_empty() }))
}
