//! Repository members: other accounts, or organizations' teams (`team:<org>/<team>`), that
//! use a repository with a role. The adapter has already checked that the account or team
//! exists; the authority decides who may add, change or remove whom. Admins act as the
//! owner except that they cannot delete the repository or add, change or remove admins;
//! nobody can make the owner a member.
use super::auth::Actor;
use super::rows::Settings;
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// Ordered by what they allow (`Read` least), so a caller's highest role wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Read,
    Write,
    Land,
    Admin,
}

impl Role {
    pub fn parse(role: &str) -> Result<Self> {
        match role {
            "read" => Ok(Self::Read),
            "write" => Ok(Self::Write),
            "land" => Ok(Self::Land),
            "admin" => Ok(Self::Admin),
            _ => Err(bad("Role must be read, write, land or admin")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Land => "land",
            Self::Admin => "admin",
        }
    }
    /// The repository scopes the role holds. `check` comes with `write`: required checks
    /// are bound to their posters, so a writer's check satisfies no gate it isn't named in.
    /// An admin also acts as the owner (see `Actor::require_owner`).
    pub fn scopes(self) -> &'static [&'static str] {
        match self {
            Self::Read => &["read"],
            Self::Write => &["read", "write", "check"],
            Self::Land | Self::Admin => &["read", "write", "check", "review", "land"],
        }
    }
}

/// The role `account` holds here, if it is a member.
pub fn role_of<S: SqlStore>(db: &S, account: &str) -> Result<Option<Role>> {
    db.query(
        "SELECT role FROM members WHERE account=?",
        &[json!(account)],
    )?
    .first()
    .map(|row| Role::parse(row["role"].as_str().unwrap_or_default()))
    .transpose()
}

/// Members as a published head's access snapshot holds them.
pub fn live<S: SqlStore>(db: &S) -> Result<Vec<Value>> {
    db.query("SELECT account,role FROM members ORDER BY account", &[])
}

/// `repo_members`: every member, for the owner and admins.
pub fn list<S: SqlStore>(db: &S) -> Result<Value> {
    Ok(json!({
        "members": db.query("SELECT account,role,added_by,added_at FROM members ORDER BY account", &[])?,
    }))
}

/// The owner's and admins' common checks: a valid account other than the owner, and an
/// admin only when the owner acts (to grant it or to change or remove an existing one).
fn target<S: SqlStore>(
    db: &S,
    c: &Value,
    actor: &Actor,
    settings: &Settings,
) -> Result<(String, Option<Role>)> {
    let account = string(c, "account")?;
    if account.trim().eq_ignore_ascii_case(&settings.workspace) {
        return Err(Error::new(
            "FORBIDDEN",
            "The owner is not a member and cannot be changed or removed",
        ));
    }
    let account = member_key(&account)?;
    let current = role_of(db, &account)?;
    if current == Some(Role::Admin) {
        actor.require_repo_owner()?;
    }
    Ok((account, current))
}

/// A team name: 1-32 characters of a-z, 0-9, `_` and `-`, starting with a letter or digit.
pub(crate) fn valid_team_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A member entry: an account, or an organization's team as `team:<org>/<team>` (whose
/// members the adapter resolves per request; see `auth`).
fn member_key(account: &str) -> Result<String> {
    let Some(team) = account.trim().strip_prefix("team:") else {
        return yoneda_core::account::normalize_account_identifier(account);
    };
    let (org, name) = team.split_once('/').unwrap_or_default();
    let org_valid = !org.contains('@')
        && yoneda_core::account::normalize_account_identifier(org).is_ok_and(|o| o == org);
    if !org_valid || !valid_team_name(name) {
        return Err(bad("A team entry is team:<org>/<team>"));
    }
    Ok(format!("team:{org}/{name}"))
}

/// `repo_member_put {account, role}`: adds a member or changes its role.
pub fn put<S: SqlStore>(db: &S, c: &Value, actor: &Actor, settings: &Settings) -> Result<Value> {
    let role = Role::parse(&string(c, "role")?)?;
    if role == Role::Admin {
        actor.require_repo_owner()?;
    }
    let (account, current) = target(db, c, actor, settings)?;
    db.query(
        "INSERT INTO members(account,role,added_by,added_at) VALUES(?,?,?,?) \
         ON CONFLICT(account) DO UPDATE SET role=excluded.role",
        &[
            json!(account),
            json!(role.as_str()),
            json!(actor.principal),
            json!(number(c, "now")?),
        ],
    )?;
    Ok(json!({
        "account": account, "role": role.as_str(),
        "previous": current.map(Role::as_str),
    }))
}

/// `repo_member_remove {account}`: access ends with this commit.
pub fn remove<S: SqlStore>(db: &S, c: &Value, actor: &Actor, settings: &Settings) -> Result<Value> {
    let (account, current) = target(db, c, actor, settings)?;
    if current.is_none() {
        return Err(Error::new(
            "NOT_FOUND",
            format!("{account} is not a member"),
        ));
    }
    db.query("DELETE FROM members WHERE account=?", &[json!(account)])?;
    Ok(json!({ "account": account, "removed": true }))
}
