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

/// Ordered by what they allow (`Read` least), so a caller's highest role wins. Serializes
/// as its lowercase name, like `Role::as_str`.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
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

/// `repo_members`: every member, for the owner and admins. A team shows by name, with the
/// id of the team it was granted to (`team_id`).
pub fn list<S: SqlStore>(db: &S) -> Result<Value> {
    let rows = db.query(
        "SELECT account,role,added_by,added_at FROM members ORDER BY account",
        &[],
    )?;
    let members = rows
        .into_iter()
        .map(|mut row| {
            let key = row["account"].as_str().unwrap_or_default().to_owned();
            if let Some((shown, id)) = key.split_once('#') {
                row["account"] = json!(shown);
                row["team_id"] = json!(id.parse::<i64>().ok());
            }
            row
        })
        .collect::<Vec<_>>();
    Ok(json!({ "members": members }))
}

/// A member entry as given: its stored key, the name it shows as (`team:<org>/<team>` for
/// a team) and the role it holds now. A team named without an id matches every grant made
/// to a team of that name (current or deleted).
struct Target {
    key: String,
    shown: String,
    team: bool,
    current: Option<Role>,
}

/// The rows a target names: the account's, or every grant to a team of that name.
fn rows_of<S: SqlStore>(db: &S, shown: &str, team: bool) -> Result<Vec<Value>> {
    if team {
        db.query(
            "SELECT account,role FROM members WHERE account=?1 \
             OR substr(account,1,length(?1)+1)=?1||'#'",
            &[json!(shown)],
        )
    } else {
        db.query(
            "SELECT account,role FROM members WHERE account=?",
            &[json!(shown)],
        )
    }
}

/// The owner's and admins' common checks: a valid account other than the owner, and an
/// admin only when the owner acts (to grant it or to change or remove an existing one).
fn target<S: SqlStore>(db: &S, c: &Value, actor: &Actor, settings: &Settings) -> Result<Target> {
    let account = string(c, "account")?;
    if account.trim().eq_ignore_ascii_case(&settings.workspace) {
        return Err(Error::new(
            "FORBIDDEN",
            "The owner is not a member and cannot be changed or removed",
        ));
    }
    let key = member_key(&account)?;
    let team = key.starts_with("team:");
    let shown = key.split('#').next().unwrap_or_default().to_owned();
    let mut current = None;
    for row in rows_of(db, &shown, team)? {
        current = current.max(Some(Role::parse(row["role"].as_str().unwrap_or_default())?));
    }
    if current == Some(Role::Admin) {
        actor.require_repo_owner()?;
    }
    Ok(Target {
        key,
        shown,
        team,
        current,
    })
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

/// A member entry: an account, or an organization's team as `team:<org>/<team>`, with the
/// team's id (`#<id>`) once the adapter resolved it (its members are resolved per request;
/// see `auth`).
fn member_key(account: &str) -> Result<String> {
    let Some(team) = account.trim().strip_prefix("team:") else {
        return yoneda_core::account::normalize_account_identifier(account);
    };
    let (team, id) = match team.split_once('#') {
        Some((team, id)) => (team, Some(id)),
        None => (team, None),
    };
    let (org, name) = team.split_once('/').unwrap_or_default();
    let org_valid = !org.contains('@')
        && yoneda_core::account::normalize_account_identifier(org).is_ok_and(|o| o == org);
    let id_valid = id.is_none_or(|id| {
        !id.is_empty() && id.len() <= 18 && id.bytes().all(|b| b.is_ascii_digit())
    });
    if !org_valid || !valid_team_name(name) || !id_valid {
        return Err(bad("A team entry is team:<org>/<team>"));
    }
    Ok(match id {
        Some(id) => format!("team:{org}/{name}#{id}"),
        None => format!("team:{org}/{name}"),
    })
}

/// `repo_member_put {account, role}`: adds a member or changes its role. A team is granted
/// by id; the grant replaces any earlier one to a team of the same name (`replaced`).
pub fn put<S: SqlStore>(db: &S, c: &Value, actor: &Actor, settings: &Settings) -> Result<Value> {
    let role = Role::parse(&string(c, "role")?)?;
    if role == Role::Admin {
        actor.require_repo_owner()?;
    }
    let t = target(db, c, actor, settings)?;
    if t.team && t.key == t.shown {
        return Err(bad(
            "A team grant names the team's id (team:<org>/<team>#<id>)",
        ));
    }
    let mut replaced = Vec::new();
    for row in rows_of(db, &t.shown, t.team)? {
        if row["account"] != t.key.as_str() {
            db.query(
                "DELETE FROM members WHERE account=?",
                &[row["account"].clone()],
            )?;
            replaced.push(row["account"].clone());
        }
    }
    db.query(
        "INSERT INTO members(account,role,added_by,added_at) VALUES(?,?,?,?) \
         ON CONFLICT(account) DO UPDATE SET role=excluded.role",
        &[
            json!(t.key),
            json!(role.as_str()),
            json!(actor.principal),
            json!(number(c, "now")?),
        ],
    )?;
    Ok(json!({
        "account": t.shown, "key": t.key, "role": role.as_str(),
        "previous": t.current.map(Role::as_str), "replaced": replaced,
    }))
}

/// `repo_member_remove {account}`: access ends with this commit. A team named without an
/// id loses every grant made to a team of that name (`keys`).
pub fn remove<S: SqlStore>(db: &S, c: &Value, actor: &Actor, settings: &Settings) -> Result<Value> {
    let t = target(db, c, actor, settings)?;
    let keys: Vec<Value> = if t.key == t.shown {
        rows_of(db, &t.shown, t.team)?
            .into_iter()
            .map(|r| r["account"].clone())
            .collect()
    } else {
        rows_of(db, &t.shown, t.team)?
            .into_iter()
            .map(|r| r["account"].clone())
            .filter(|k| *k == t.key.as_str())
            .collect()
    };
    if keys.is_empty() {
        return Err(Error::new(
            "NOT_FOUND",
            format!("{} is not a member", t.shown),
        ));
    }
    for key in &keys {
        db.query(
            "DELETE FROM members WHERE account=?",
            std::slice::from_ref(key),
        )?;
    }
    Ok(json!({ "account": t.shown, "removed": true, "keys": keys }))
}
