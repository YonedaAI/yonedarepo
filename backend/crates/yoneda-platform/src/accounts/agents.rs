//! Agents: a named personal token an account's person approved through the device flow. The
//! name lives in the token's `origin` (`agent:<name>`) and, while a code waits, in its
//! `client_name`, so neither needs a column. An agent does repository work and nothing more: it
//! holds no account scope, belongs to no organization limit, and mints no credential.
use super::*;
use crate::storage::string;

const PREFIX: &str = "agent:";
const NAME_LIMIT: usize = 32;
const LIVE_LIMIT: usize = 10;
const SCOPES: [&str; 4] = ["repo:read", "repo:write", "repo:land", "repo:review"];

/// 1-32 lowercase letters, digits, `-` and `_`, starting with a letter or digit. No `/` or `:`,
/// since the name ends a principal (`agent:<account>/<name>`).
fn valid(name: &str) -> bool {
    let word = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    name.len() <= NAME_LIMIT
        && name.as_bytes().first().copied().is_some_and(word)
        && name.bytes().all(|b| word(b) || b == b'-' || b == b'_')
}

/// The agent a label (a token's origin, a waiting code's client) names, if any.
pub(super) fn named(label: &str) -> Option<&str> {
    label.strip_prefix(PREFIX).filter(|name| valid(name))
}

/// Whether a client's own name claims to be an agent's, which only `asked` may say.
pub(super) fn claims(client: &str) -> bool {
    client.starts_with(PREFIX)
}

/// The label of the agent a device code asks for (`agent`), or None for a plain login.
pub(super) fn asked(c: &Value) -> Result<Option<String>> {
    match &c["agent"] {
        Value::Null => Ok(None),
        Value::String(name) if valid(name) => Ok(Some(format!("{PREFIX}{name}"))),
        _ => Err(bad(
            "An agent's name is 1-32 lowercase letters, digits, - and _",
        )),
    }
}

/// Refuses a grant wider than an agent may hold.
pub(super) fn allow(grant: &Value) -> Result<()> {
    let held = grant["scopes"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if !held
        .iter()
        .all(|s| s.as_str().is_some_and(|s| SCOPES.contains(&s)))
    {
        return Err(bad(&format!(
            "An agent's scopes are some of {}",
            SCOPES.join(", ")
        )));
    }
    if !grant["org"].is_null() {
        return Err(bad("An agent is not limited to an organization"));
    }
    Ok(())
}

/// Refuses `name` when it is live already, or the account holds all the agents it may.
pub(super) fn room<S: SqlStore>(db: &S, name: &str, now: i64) -> Result<()> {
    let live = db.query(
        "SELECT origin FROM account_tokens WHERE origin LIKE 'agent:%' \
         AND revoked_at IS NULL AND expires_at>?",
        &[json!(now)],
    )?;
    if live
        .iter()
        .any(|r| r["origin"].as_str().and_then(named) == Some(name))
    {
        return Err(Error::new(
            "CONFLICT",
            format!("Settings → Signed-in CLIs: sign out the agent named {name} first."),
        ));
    }
    if live.len() >= LIVE_LIMIT {
        return Err(Error::new(
            "CONFLICT",
            format!(
                "Settings → Signed-in CLIs: sign out an agent first. An account holds {LIVE_LIMIT}."
            ),
        ));
    }
    Ok(())
}

/// `pat_agent_room {name}`: the same refusal `pat_create` gives, before a code is spent on it.
pub(super) fn check_room<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let name = string(c, "name")?;
    if !valid(&name) {
        return Err(bad("Invalid agent name"));
    }
    room(db, &name, now)?;
    Ok(json!({"room": true}))
}
