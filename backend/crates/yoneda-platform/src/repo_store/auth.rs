//! Who is calling. Workspace sessions are owners with every scope; repository tokens are
//! API principals (agents, CI, scripts) with explicit scopes. The platform never sees
//! *what kind* of client a token belongs to, only its name and scopes. Another account's
//! session or personal token acts by its membership role (`members`), capped by the token.
//! On a repository an organization owns, the org's owners act as the owner; anyone else,
//! org members included, needs a membership role: their own row or one of their teams'
//! (`team:<org>/<team>`), whichever is highest. The adapter resolves an account's orgs and
//! teams from each org's authority (`orgs` on `_session` or `_pat`) for every request.
//! Anyone else is told NOT_FOUND on a private repository and reads a public one as a
//! public reader (`visibility`); a caller without credentials is `_anonymous`.
mod pat;

use super::members::Role;
use super::org_access::Orgs;
use super::rows::Settings;
use crate::storage::{SqlStore, bad, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub struct Actor {
    pub principal: String,
    /// The owner, or an admin member acting as the owner (see `require_repo_owner`).
    pub owner: bool,
    /// The caller's membership role when it is not the owner's account.
    pub member: Option<Role>,
    /// A person signed in to their own account (never a token, platform role or script).
    human: bool,
    /// An account's personal access token: whole-repository Git reads with `read`.
    account_token: bool,
    scopes: Vec<String>,
    /// Directory grant (`None`: whole repository).
    pub grant: super::grants::Grant,
    /// Reads only because the repository is public (not the owner, a member or its token).
    pub public: bool,
}

impl Actor {
    pub fn require(&self, scope: &str) -> Result<()> {
        if self.owner || self.scopes.iter().any(|s| s == scope) {
            Ok(())
        } else {
            Err(Error::new(
                "FORBIDDEN",
                format!("Token lacks the {scope} scope"),
            ))
        }
    }
    /// Whether this actor holds `scope` itself (owners hold every token scope, not roles).
    pub fn can(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
    pub fn require_any(&self, scopes: &[&str]) -> Result<()> {
        if scopes.iter().any(|s| self.require(s).is_ok()) {
            Ok(())
        } else {
            Err(Error::new(
                "FORBIDDEN",
                format!("Token needs one of the {} scopes", scopes.join("/")),
            ))
        }
    }
    /// Git clone access: a person signed in to their own account, or that account's personal
    /// token with `repo:read`, who may read the whole repository. Repository tokens and
    /// scripts use the API; a directory grant cannot clone it all.
    pub fn require_human_reader(&self) -> Result<()> {
        let reader = (self.human && (self.owner || self.can("read")))
            || (self.account_token && self.can("read"));
        if reader && self.grant.is_none() {
            Ok(())
        } else {
            Err(Error::new(
                "FORBIDDEN",
                "Git clone access is for a signed-in person who can read the whole repository",
            ))
        }
    }
    /// Break-glass gate: the owner's own signed-in session (never an admin member); every
    /// other caller gets the same refusal, whatever it holds.
    pub fn require_human_owner(&self) -> Result<()> {
        if self.owner && self.human && self.member.is_none() {
            Ok(())
        } else {
            Err(super::break_glass::refusal())
        }
    }
    /// A public reader without credentials.
    pub fn anonymous(&self) -> bool {
        self.public && self.principal == ANONYMOUS
    }
    /// The owner's account itself (never an admin member).
    pub fn repo_owner(&self) -> bool {
        self.owner && self.member.is_none()
    }
    /// The owner's account itself: deleting the repository and managing admins.
    pub fn require_repo_owner(&self) -> Result<()> {
        if self.repo_owner() {
            Ok(())
        } else {
            Err(Error::new(
                "FORBIDDEN",
                "Only the repository owner can do this",
            ))
        }
    }
    /// The owner or an admin member.
    pub fn require_owner(&self) -> Result<()> {
        if self.owner {
            Ok(())
        } else {
            Err(Error::new(
                "FORBIDDEN",
                "Only the repository owner can do this",
            ))
        }
    }
}

/// The principal of a public reader without credentials.
const ANONYMOUS: &str = "anonymous";

/// A public reader acting as `principal`: `read` over the whole repository, nothing else.
fn public_reader(principal: String) -> Actor {
    Actor {
        principal,
        owner: false,
        member: None,
        human: false,
        account_token: false,
        scopes: vec!["read".to_owned()],
        grant: None,
        public: true,
    }
}

/// A caller that is neither the owner nor a member: a public reader of a public repository;
/// on a private one, the repository does not exist for it.
fn outsider(principal: String, public: bool) -> Result<Actor> {
    if public {
        Ok(public_reader(principal))
    } else {
        Err(not_found())
    }
}

pub(super) fn token_digest(secret: &str) -> String {
    yoneda_core::digest(format!("yonedarepo:repo-token:v1:{secret}").as_bytes())
}

/// `_session`, `_token`, `_pat`, `_anonymous` and `_system` are set by the authenticating
/// adapter, never by callers. `_session.human` marks a personal account session (not an
/// admin bearer). `_system` names a platform role (check executor, ref projector, importer,
/// merger), each holding only the scope its job needs.
pub fn actor<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Actor> {
    actor_with(
        c,
        &settings.workspace,
        settings.visibility == super::visibility::Visibility::Public,
        |digest| {
            Ok(db
                .query(
                    "SELECT name,scopes,paths FROM tokens WHERE digest=? AND revoked_at IS NULL",
                    &[json!(digest)],
                )?
                .into_iter()
                .next())
        },
        |account| super::members::role_of(db, account),
    )
}

/// The actor for credentials `c` on a repository of `workspace` (`public` when anyone
/// reads it), with live tokens looked up by digest through `token` and members' roles by
/// account through `member` (the authority's tables, or a published snapshot of them).
pub fn actor_with(
    c: &Value,
    workspace: &str,
    public: bool,
    token: impl Fn(&str) -> Result<Option<Value>>,
    member: impl Fn(&str) -> Result<Option<Role>>,
) -> Result<Actor> {
    if let Some(
        system @ ("checks" | "projection" | "import" | "merge" | "repair" | "derive" | "commits"
        | "purge" | "hooks" | "compact" | "fork"),
    ) = c.get("_system").and_then(Value::as_str)
    {
        let roles: &[&str] = match system {
            "import" => &["import"],
            "merge" => &["write", "lander"],
            "repair" => &["write"],
            "derive" => &["classify"],
            "hooks" => &["hooks"],
            "compact" => &["compact"],
            // Carries a fork's change into its parent: records commits, moves the mirror.
            "fork" => &["write", "fork"],
            _ => &["system"],
        };
        return Ok(Actor {
            principal: format!("platform:{system}"),
            owner: false,
            member: None,
            human: false,
            account_token: false,
            grant: None,
            public: false,
            scopes: std::iter::once("read")
                .chain(roles.iter().copied())
                .map(str::to_owned)
                .collect(),
        });
    }
    if c.get("_anonymous") == Some(&Value::Bool(true)) {
        return outsider(ANONYMOUS.to_owned(), public);
    }
    if let Some(session) = c.get("_session").filter(|s| s.is_object()) {
        let account = string(session, "workspace")?;
        let principal = string(session, "principal")?;
        let human = session["human"] == true;
        if account == workspace {
            return Ok(Actor {
                principal,
                owner: true,
                member: None,
                human,
                account_token: false,
                scopes: Vec::new(),
                grant: None,
                public: false,
            });
        }
        // Only an account's own session is a member (never an admin bearer for it).
        if principal != format!("user:{account}") {
            return outsider(principal, public);
        }
        let orgs = Orgs::of(session)?;
        if orgs.owns(workspace) {
            return Ok(Actor {
                principal,
                owner: true,
                member: None,
                human,
                account_token: false,
                scopes: Vec::new(),
                grant: None,
                public: false,
            });
        }
        let Some(role) = orgs.role(&account, &member)? else {
            return outsider(principal, public);
        };
        return Ok(Actor {
            principal,
            owner: role == Role::Admin,
            member: Some(role),
            human,
            account_token: false,
            scopes: role.scopes().iter().map(|s| (*s).to_owned()).collect(),
            grant: None,
            public: false,
        });
    }
    if let Some(pat) = c.get("_pat").filter(|s| s.is_object()) {
        return pat::account_token(pat, workspace, public, member);
    }
    let secret =
        string(c, "_token").map_err(|_| Error::new("UNAUTHORIZED", "Missing credentials"))?;
    let row = token(&token_digest(&secret))?
        .ok_or_else(|| Error::new("UNAUTHORIZED", "Unknown or revoked token"))?;
    Ok(Actor {
        principal: format!("token:{}", row["name"].as_str().unwrap_or_default()),
        owner: false,
        member: None,
        human: false,
        account_token: false,
        scopes: serde_json::from_str(row["scopes"].as_str().unwrap_or("[]"))
            .map_err(|_| bad("Corrupt scopes"))?,
        grant: match row["paths"].as_str() {
            Some(paths) => Some(serde_json::from_str(paths).map_err(|_| bad("Corrupt grant"))?),
            None => None,
        },
        public: false,
    })
}

/// The refusal for an account that is neither owner nor member of a private repository:
/// the same answer as a repository that does not exist, so its existence does not leak.
fn not_found() -> Error {
    Error::new("NOT_FOUND", "Repository not found")
}

/// Live tokens as a published snapshot holds them (digests only, never secrets).
pub fn live_tokens<S: SqlStore>(db: &S) -> Result<Vec<Value>> {
    db.query(
        "SELECT digest,name,scopes,paths FROM tokens WHERE revoked_at IS NULL ORDER BY name",
        &[],
    )
}
