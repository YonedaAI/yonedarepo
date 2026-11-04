//! `token create|list|revoke` and `log`: the clone's own repository tokens (one per sandboxed
//! agent, each landing as `token:<name>`) and the landings its log holds, with who made
//! each. A new token's secret goes to stdout once and is stored nowhere: the authority keeps
//! its digest only.
use crate::authority::Cred;
use crate::layout::{Layout, local_error};
use crate::service::Service;
use serde_json::{Value, json};
use std::path::Path;
use yoneda_core::Result;

/// The scopes an agent's token carries: fetch, push and land.
const SCOPES: [&str; 3] = ["read", "write", "land"];
/// The service's own tokens (`init`'s and sync's): never revoked or reused from here.
const RESERVED: [&str; 2] = ["local", "cloud-sync"];
/// The newest log entries `log` shows.
const LOG_LIMIT: u64 = 100;

/// A new token secret: `ylt_` and 32 random bytes in hex.
pub fn new_secret() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| local_error(format!("No randomness: {e}")))?;
    Ok(format!(
        "ylt_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

pub fn run(cwd: &Path, args: &[String]) -> Result<String> {
    let svc = Service::open(&Layout::find(cwd)?)?;
    let name = args.get(1).map(String::as_str);
    match (args.first().map(String::as_str), name) {
        (Some("create"), Some(name)) => create(&svc, name),
        (Some("list"), None) => list(&svc),
        (Some("revoke"), Some(name)) => revoke(&svc, name),
        _ => Err(local_error(
            "usage: yoneda local token <create <name> | list | revoke <name>>",
        )),
    }
}

fn unreserved(name: &str) -> Result<()> {
    if RESERVED.contains(&name) {
        return Err(local_error(format!(
            "{name} is the service's own token; choose another name"
        )));
    }
    Ok(())
}

fn create(svc: &Service, name: &str) -> Result<String> {
    unreserved(name)?;
    let secret = new_secret()?;
    let made = svc.authority.call(
        &Cred::Owner,
        json!({ "op": "repo_token_create", "name": name, "scopes": SCOPES, "_secret": secret }),
    )?;
    eprintln!(
        "token {name} ({}): read, write, land. Shown once; give it to one agent as its Git password.",
        made["principal"].as_str().unwrap_or_default()
    );
    Ok(secret)
}

fn list(svc: &Service) -> Result<String> {
    let listed = svc
        .authority
        .call(&Cred::Owner, json!({ "op": "repo_tokens" }))?;
    let rows = listed["tokens"].as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        return Ok("No tokens".into());
    }
    Ok(rows
        .iter()
        .map(|t| {
            let state = if t["revoked_at"].is_null() {
                "active"
            } else {
                "revoked"
            };
            format!(
                "{}  {}  {state}",
                t["name"].as_str().unwrap_or_default(),
                scopes(&t["scopes"])
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

/// A token row's scopes, stored as JSON text.
fn scopes(stored: &Value) -> String {
    let parsed: Vec<String> = stored
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    parsed.join(",")
}

fn revoke(svc: &Service, name: &str) -> Result<String> {
    unreserved(name)?;
    let done = svc.authority.call(
        &Cred::Owner,
        json!({ "op": "repo_token_revoke", "name": name }),
    )?;
    Ok(if done["revoked"] == true {
        format!("Revoked {name}")
    } else {
        format!("{name} was not an active token")
    })
}

/// `log [--json]`: the newest landings, oldest first: version, kind, ref, commit, actor.
pub fn log(cwd: &Path, as_json: bool) -> Result<String> {
    let svc = Service::open(&Layout::find(cwd)?)?;
    let version = crate::sync::main_version(&svc)?;
    let read = svc.authority.call(
        &Cred::Owner,
        json!({ "op": "repo_txlog", "after": version.saturating_sub(LOG_LIMIT),
                "limit": LOG_LIMIT }),
    )?;
    let entries: Vec<Value> = read["entries"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|e| {
            json!({ "version": e["version"], "kind": e["kind"], "ref": e["refname"],
                    "commit": e["new"], "actor": e["actor"] })
        })
        .collect();
    if as_json {
        return Ok(json!({ "entries": entries }).to_string());
    }
    Ok(entries
        .iter()
        .map(|e| {
            let field = |k: &str| {
                e[k].as_str()
                    .map_or_else(|| e[k].to_string(), str::to_owned)
            };
            format!(
                "{} {} {} {} {}",
                e["version"],
                field("kind"),
                field("ref"),
                field("commit"),
                field("actor")
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}
