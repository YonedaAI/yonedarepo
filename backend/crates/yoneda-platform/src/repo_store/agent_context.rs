//! `repo_agent_context`: what a coding agent starting a session in a clone should know
//! about the repository, in one read of the authority: the heads of main and of the
//! agent's branch, the landing rules, the newest session records (what earlier sessions
//! did, newest first), the open change requests, the authored symbol contracts on the
//! paths the agent is working on (then the newest others), and the repository's current
//! memories ranked for those paths (`memory::relevance`, the newest others filling the
//! rest). Every list is bounded; the client renders and caps the text it hands the agent.
use super::auth::Actor;
use super::rows::{self, Settings};
use super::{agent_reads, changes, sessions};
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use yoneda_core::Result;

const MAX_PATHS: usize = 100;
const MAX_CONTRACTS: u64 = 10;
const MAX_CHANGES: u64 = 20;
const MAX_SESSIONS: u64 = 50;
const MAX_MEMORIES: u64 = 20;

fn count(c: &Value, key: &str, default: u64, max: u64) -> Result<u64> {
    match &c[key] {
        Value::Null => Ok(default),
        v => v
            .as_u64()
            .filter(|n| (1..=max).contains(n))
            .ok_or_else(|| bad(&format!("{key} must be 1-{max}"))),
    }
}

fn head<S: SqlStore>(db: &S, branch: &str) -> Result<Value> {
    Ok(db
        .query(
            "SELECT commit_id FROM refs WHERE name=?",
            &[json!(format!("refs/heads/{branch}"))],
        )?
        .first()
        .map(|r| r["commit_id"].clone())
        .unwrap_or(Value::Null))
}

/// The newest record of each contract, those on `paths` first.
fn contracts<S: SqlStore>(db: &S, paths: &[String], limit: u64) -> Result<Vec<Value>> {
    // The paths go as one JSON array: a parameter each would pass the 100 a statement binds.
    let rows = db.query(
        "SELECT seq,path,symbol_path,commit_id,contract,recorded_at,\
         path IN (SELECT value FROM json_each(?)) AS wanted \
         FROM symbol_contracts WHERE seq IN \
         (SELECT MAX(seq) FROM symbol_contracts GROUP BY path,symbol_path) \
         ORDER BY wanted DESC, seq DESC LIMIT ?",
        &[json!(json!(paths).to_string()), json!(limit)],
    )?;
    rows.into_iter()
        .map(|row| {
            let contract: Value =
                serde_json::from_str(row["contract"].as_str().unwrap_or_default())
                    .map_err(|_| rows::corrupt("contract record"))?;
            Ok(
                json!({ "seq": row["seq"], "path": row["path"], "symbol_path": row["symbol_path"],
                "commit": row["commit_id"], "contract": contract,
                "recorded_at": row["recorded_at"], "on_paths": row["wanted"] == 1 }),
            )
        })
        .collect()
}

/// `repo_agent_context {branch?, paths?, sessions?, changes?, contracts?, memories?}`.
pub fn context<S: SqlStore>(
    db: &S,
    c: &Value,
    actor: &Actor,
    settings: &Settings,
) -> Result<Value> {
    sessions::whole_repository(actor)?;
    let branch = match c["branch"].as_str() {
        None => None,
        Some(name) => Some(
            rows::branch_ref(&json!({ "ref": name }))?
                .trim_start_matches("refs/heads/")
                .to_owned(),
        ),
    };
    let paths: Vec<String> = match &c["paths"] {
        Value::Null => Vec::new(),
        v => serde_json::from_value(v.clone())
            .map_err(|_| bad("paths must be a list of file paths"))?,
    };
    if paths.len() > MAX_PATHS {
        return Err(bad(&format!("At most {MAX_PATHS} paths")));
    }
    for path in &paths {
        yoneda_core::validate_path(path)?;
    }
    let recent = agent_reads::session_list(
        db,
        &json!({ "limit": count(c, "sessions", 8, MAX_SESSIONS)? }),
        actor,
    )?;
    let open = changes::list(
        db,
        &json!({ "status": "open", "limit": count(c, "changes", 10, MAX_CHANGES)? }),
        actor,
    )?;
    let branch_head = match &branch {
        Some(b) => head(db, b)?,
        None => Value::Null,
    };
    Ok(json!({
        "version": rows::current_version(db)?,
        "main": head(db, "main")?,
        "branch": branch.map(|name| json!({ "name": name, "head": branch_head })),
        "policy": settings.policy,
        "sessions": recent["sessions"],
        "changes": open["changes"],
        "contracts": contracts(db, &paths, count(c, "contracts", 5, MAX_CONTRACTS)?)?,
        "memories": super::memory::relevance::for_start(
            db, &paths, count(c, "memories", 8, MAX_MEMORIES)?)?,
    }))
}
