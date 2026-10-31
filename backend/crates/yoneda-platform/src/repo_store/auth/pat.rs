//! Personal access tokens on a repository: the account's own repository scopes, capped by
//! its membership role elsewhere.
use super::{Actor, Orgs, Role, outsider};
use crate::storage::{bad, string};
use serde_json::Value;
use yoneda_core::{Error, Result};

/// A personal access token the adapter verified against its account: the account's
/// principal (never human, so break-glass stays out of reach), `repo:admin` as the owner,
/// and the other `repo:` scopes as the repository scopes of the same name; an `account:`
/// scope is about the account, so it adds nothing here. On another
/// account's repository the token holds only what both it and the membership role allow
/// (`repo:admin` counting as every scope); on a public repository it is not a member of,
/// it reads as a public reader (its organization limit still holds). The adapter enforces
/// the token's repository allowlist before calling.
pub(super) fn account_token(
    pat: &Value,
    workspace: &str,
    public: bool,
    member: impl Fn(&str) -> Result<Option<Role>>,
) -> Result<Actor> {
    let account = string(pat, "workspace")?;
    let held: Vec<String> =
        serde_json::from_value(pat["scopes"].clone()).map_err(|_| bad("Corrupt token scopes"))?;
    let mut scopes = Vec::new();
    let mut admin = false;
    for scope in &held {
        match scope.as_str() {
            crate::accounts::SSH_KEYS_SCOPE => {}
            "repo:admin" => admin = true,
            "repo:read" | "repo:write" | "repo:land" | "repo:review" => {
                scopes.push(scope["repo:".len()..].to_owned())
            }
            _ => return Err(Error::new("FORBIDDEN", "Unknown token scope")),
        }
    }
    if let Some(org) = pat.get("org").and_then(Value::as_str)
        && org != workspace
    {
        return Err(Error::new(
            "FORBIDDEN",
            format!("This token is limited to the {org} organization's repositories"),
        ));
    }
    let orgs = Orgs::of(pat)?;
    let role = if account == workspace || orgs.owns(workspace) {
        None
    } else {
        let Some(role) = orgs.role(&account, &member)? else {
            return outsider(string(pat, "principal")?, public);
        };
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
        public: false,
    })
}
