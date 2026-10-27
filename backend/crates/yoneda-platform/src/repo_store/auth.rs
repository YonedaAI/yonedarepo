//! Who is calling. Workspace sessions are owners with every scope; repository tokens are
//! API principals (agents, CI, scripts) with explicit scopes. The platform never sees
//! *what kind* of client a token belongs to, only its name and scopes. Another account's
//! session or personal token acts by its membership role (`members`), capped by the token.
use super::members::Role;
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

pub(super) fn token_digest(secret: &str) -> String {
    yoneda_core::digest(format!("yonedarepo:repo-token:v1:{secret}").as_bytes())
}

/// `_session`, `_token` and `_system` are set by the authenticating adapter, never by
/// callers. `_session.human` marks a personal account session (not an admin bearer). `_system` names a platform role (check executor, ref projector, importer,
/// merger), each holding only the scope its job needs.
pub fn actor<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Actor> {
    actor_with(
        c,
        &settings.workspace,
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

/// The actor for credentials `c`, with live tokens looked up by digest through `token`
/// and members' roles by account through `member` (the authority's tables, or a
/// published snapshot of them).
pub fn actor_with(
    c: &Value,
    workspace: &str,
    token: impl Fn(&str) -> Result<Option<Value>>,
    member: impl Fn(&str) -> Result<Option<Role>>,
) -> Result<Actor> {
    if let Some(
        system @ ("checks" | "projection" | "import" | "merge" | "repair" | "derive" | "commits"
        | "purge" | "hooks"),
    ) = c.get("_system").and_then(Value::as_str)
    {
        let roles: &[&str] = match system {
            "import" => &["import"],
            "merge" => &["write", "lander"],
            "repair" => &["write"],
            "derive" => &["classify"],
            "hooks" => &["hooks"],
            _ => &["system"],
        };
        return Ok(Actor {
            principal: format!("platform:{system}"),
            owner: false,
            member: None,
            human: false,
            account_token: false,
            grant: None,
            scopes: std::iter::once("read")
                .chain(roles.iter().copied())
                .map(str::to_owned)
                .collect(),
        });
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
            });
        }
        // Only an account's own session is a member (never an admin bearer for it).
        if principal != format!("user:{account}") {
            return Err(not_member());
        }
        let role = member(&account)?.ok_or_else(not_member)?;
        return Ok(Actor {
            principal,
            owner: role == Role::Admin,
            member: Some(role),
            human,
            account_token: false,
            scopes: role.scopes().iter().map(|s| (*s).to_owned()).collect(),
            grant: None,
        });
    }
    if let Some(pat) = c.get("_pat").filter(|s| s.is_object()) {
        return account_token(pat, workspace, member);
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
    })
}

fn not_member() -> Error {
    Error::new("FORBIDDEN", "Repository belongs to another workspace")
}

/// A personal access token the adapter verified against its account: the account's
/// principal (never human, so break-glass stays out of reach), `repo:admin` as the owner,
/// and the other account scopes as the repository scopes of the same name. On another
/// account's repository the token holds only what both it and the membership role allow
/// (`repo:admin` counting as every scope). The adapter enforces the token's repository
/// allowlist before calling.
fn account_token(
    pat: &Value,
    workspace: &str,
    member: impl Fn(&str) -> Result<Option<Role>>,
) -> Result<Actor> {
    let account = string(pat, "workspace")?;
    let held: Vec<String> =
        serde_json::from_value(pat["scopes"].clone()).map_err(|_| bad("Corrupt token scopes"))?;
    let mut scopes = Vec::new();
    let mut admin = false;
    for scope in &held {
        match scope.as_str() {
            "repo:admin" => admin = true,
            "repo:read" | "repo:write" | "repo:land" | "repo:review" => {
                scopes.push(scope["repo:".len()..].to_owned())
            }
            _ => return Err(Error::new("FORBIDDEN", "Unknown token scope")),
        }
    }
    let role = if account == workspace {
        None
    } else {
        let role = member(&account)?.ok_or_else(not_member)?;
        scopes = role
            .scopes()
            .iter()
            .filter(|s| admin || scopes.iter().any(|held| held == *s))
            .map(|s| (*s).to_owned())
            .collect();
        Some(role)
    };
    Ok(Actor {
        principal: string(pat, "principal")?,
        owner: admin && role.is_none_or(|r| r == Role::Admin),
        member: role,
        human: false,
        account_token: true,
        scopes,
        grant: None,
    })
}

/// Live tokens as a published snapshot holds them (digests only, never secrets).
pub fn live_tokens<S: SqlStore>(db: &S) -> Result<Vec<Value>> {
    db.query(
        "SELECT digest,name,scopes,paths FROM tokens WHERE revoked_at IS NULL ORDER BY name",
        &[],
    )
}
