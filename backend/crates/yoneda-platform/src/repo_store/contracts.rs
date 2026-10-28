//! Authored contract records: the one authoritative source for a symbol's contract when
//! one has been written. Each record binds the contract to the commit it was written
//! against and to the symbol's node digest there, so readers can tell when the symbol has
//! moved on and the record is stale. Records are append-only; reads at a log version see
//! only records that existed then.
use super::rows::{self, current_version, object_id};
use crate::platform_contracts::Contract;
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

const MAX_PATHS: usize = 1000;

fn is_digest(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn record<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let commit = rows::recorded(db, &object_id(c, "commit")?)?.id;
    let path = string(c, "path")?;
    yoneda_core::validate_path(&path)?;
    let symbol_path = string(c, "symbol_path")?;
    if symbol_path.len() > 512 {
        return Err(bad("symbol_path is too long"));
    }
    let node_digest = string(c, "node_digest")?;
    if !is_digest(&node_digest) {
        return Err(bad("node_digest must be a SHA-256 hex digest"));
    }
    let contract = Contract::parse(&c["contract"])?;
    let text = serde_json::to_string(&contract).map_err(|_| bad("contract is not serializable"))?;
    let contract_digest = yoneda_core::digest(text.as_bytes());
    // A retried write of the same contract for the same node is the same record.
    let latest = db.query(
        "SELECT seq,contract_digest FROM symbol_contracts WHERE path=? AND symbol_path=? AND node_digest=? ORDER BY seq DESC LIMIT 1",
        &[json!(path), json!(symbol_path), json!(node_digest)],
    )?;
    if let Some(row) = latest
        .first()
        .filter(|r| r["contract_digest"] == contract_digest)
    {
        return Ok(
            json!({ "seq": row["seq"], "path": path, "symbol_path": symbol_path,
            "commit": commit, "node_digest": node_digest, "contract_digest": contract_digest,
            "already": true }),
        );
    }
    db.query(
        "INSERT INTO symbol_contracts(path,symbol_path,commit_id,node_digest,contract,contract_digest,recorded_by,recorded_at,recorded_version) VALUES(?,?,?,?,?,?,?,?,?)",
        &[json!(path), json!(symbol_path), json!(commit.hex()), json!(node_digest), json!(text),
            json!(contract_digest), json!(principal), json!(number(c, "now")?), json!(current_version(db)?)],
    )?;
    let seq = db.query("SELECT MAX(seq) AS seq FROM symbol_contracts", &[])?[0]["seq"].clone();
    Ok(
        json!({ "seq": seq, "path": path, "symbol_path": symbol_path, "commit": commit,
        "node_digest": node_digest, "contract_digest": contract_digest, "already": false }),
    )
}

/// The paths a contracts read names, validated.
pub fn paths(c: &Value) -> Result<Vec<String>> {
    let paths: Vec<String> = serde_json::from_value(c["paths"].clone())
        .map_err(|_| bad("paths must be a list of file paths"))?;
    if paths.len() > MAX_PATHS {
        return Err(bad("At most 1000 paths per contracts read"));
    }
    for path in &paths {
        yoneda_core::validate_path(path)?;
    }
    Ok(paths)
}

/// Authored records for `paths`, oldest first, as of log version `at` (default: now).
pub fn list<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let current = current_version(db)?;
    let at = match c.get("at").filter(|v| !v.is_null()) {
        None => current,
        Some(v) => v.as_u64().filter(|v| *v <= current).ok_or_else(|| {
            Error::new(
                "INVALID_INPUT",
                format!("at must be a version from 0 to {current}"),
            )
        })?,
    };
    let mut records = Vec::new();
    // 99 paths and the version: Durable Object SQLite binds at most 100 parameters.
    for chunk in paths(c)?.chunks(99) {
        let marks = vec!["?"; chunk.len()].join(",");
        let mut params: Vec<Value> = chunk.iter().map(|p| json!(p)).collect();
        params.push(json!(at));
        let rows = db.query(
            &format!("SELECT seq,path,symbol_path,commit_id,node_digest,contract,recorded_by,recorded_at,recorded_version FROM symbol_contracts WHERE path IN ({marks}) AND recorded_version<=? ORDER BY seq"),
            &params,
        )?;
        for row in rows {
            let contract: Value =
                serde_json::from_str(row["contract"].as_str().unwrap_or_default())
                    .map_err(|_| rows::corrupt("contract record"))?;
            records.push(json!({ "seq": row["seq"], "path": row["path"],
                "symbol_path": row["symbol_path"], "commit": row["commit_id"],
                "node_digest": row["node_digest"], "contract": contract,
                "recorded_by": row["recorded_by"], "recorded_at": row["recorded_at"],
                "recorded_version": row["recorded_version"] }));
        }
    }
    records.sort_by_key(|r| r["seq"].as_i64());
    Ok(json!({ "version": at, "records": records }))
}
