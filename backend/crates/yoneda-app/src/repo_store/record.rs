//! Recording is separate from landing: a recorded commit is durable, addressable work that
//! no ref points at yet. Checks and reviews attach to the exact commit id.
use super::rows::{self, Settings, check_name, object_id};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

/// Moves a prepared commit into history once the adapter has read it back from the
/// object store; the readback must match exactly what this store built.
pub fn record<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let id = object_id(c, "commit")?;
    if rows::commit_row(db, &id)?.is_some() {
        return Ok(json!({ "commit": id, "recorded": true, "already": true }));
    }
    let row = db
        .query(
            "SELECT payload FROM prepared_commits WHERE commit_id=? AND principal=?",
            &[json!(id.hex()), json!(principal)],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", "No prepared commit for this principal"))?;
    let prepared: Value = serde_json::from_str(row["payload"].as_str().unwrap_or_default())
        .map_err(|_| rows::corrupt("prepared commit"))?;
    let readback = &c["readback"];
    if readback["tree"] != prepared["tree"] || readback["parents"] != prepared["parents"] {
        return Err(Error::new(
            "READBACK_MISMATCH",
            "Object store readback differs from the prepared commit",
        ));
    }
    let touches = prepared["touches"]
        .as_array()
        .ok_or_else(|| rows::corrupt("touches"))?;
    db.query(
        "INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)",
        &[
            json!(id.hex()),
            prepared["tree"].clone(),
            json!(prepared["parents"].to_string()),
            prepared["generation"].clone(),
            prepared["base_version"].clone(),
            json!(principal),
            prepared["message"].clone(),
            json!(prepared["read_set"].to_string()),
            json!(number(c, "now")?),
        ],
    )?;
    for touch in touches {
        db.query(
            "INSERT INTO commit_paths(commit_id,path,op,old_blob,new_blob) VALUES(?,?,?,?,?)",
            &[
                json!(id.hex()),
                touch["path"].clone(),
                touch["op"].clone(),
                touch["old_blob"].clone(),
                touch["new_blob"].clone(),
            ],
        )?;
    }
    db.query(
        "DELETE FROM prepared_commits WHERE commit_id=?",
        &[json!(id.hex())],
    )?;
    Ok(json!({ "commit": id, "recorded": true, "paths": touches.len() }))
}

/// Records a check result for the exact commit under the repository's current policy.
pub fn check<S: SqlStore>(
    db: &S,
    c: &Value,
    principal: &str,
    settings: &Settings,
) -> Result<Value> {
    let id = object_id(c, "commit")?;
    rows::recorded(db, &id)?;
    let name = string(c, "name")?;
    check_name(&name)?;
    let status = string(c, "status")?;
    if !matches!(status.as_str(), "pass" | "fail") {
        return Err(bad("Check status must be pass or fail"));
    }
    let evidence = c["evidence"].as_str().filter(|e| e.len() <= 4096);
    db.query(
        "INSERT INTO checks(commit_id,name,policy_digest,status,evidence,principal,recorded_at) VALUES(?,?,?,?,?,?,?) \
         ON CONFLICT(commit_id,name,policy_digest) DO UPDATE SET status=excluded.status,evidence=excluded.evidence,principal=excluded.principal,recorded_at=excluded.recorded_at",
        &[json!(id.hex()), json!(name), json!(settings.policy_digest), json!(status), json!(evidence), json!(principal), json!(number(c, "now")?)],
    )?;
    Ok(json!({ "commit": id, "check": name, "status": status }))
}

/// Reviews are immutable and independent: the commit's author cannot review it.
pub fn review<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let id: ObjectId = object_id(c, "commit")?;
    let commit = rows::recorded(db, &id)?;
    if commit.principal == principal {
        return Err(Error::new(
            "FORBIDDEN",
            "Authors cannot review their own commit",
        ));
    }
    let decision = string(c, "decision")?;
    let reason = c["reason"]
        .as_str()
        .map(str::trim)
        .filter(|r| !r.is_empty() && r.len() <= 2000);
    match (decision.as_str(), reason) {
        ("approve", _) | ("reject", Some(_)) => {}
        ("reject", None) => return Err(bad("A rejection needs a reason")),
        _ => return Err(bad("Decision must be approve or reject")),
    }
    let existing = db.query(
        "SELECT decision FROM reviews WHERE commit_id=? AND principal=?",
        &[json!(id.hex()), json!(principal)],
    )?;
    if !existing.is_empty() {
        return Err(Error::new(
            "ALREADY_EXISTS",
            "This reviewer already recorded a decision",
        ));
    }
    db.query(
        "INSERT INTO reviews(commit_id,principal,decision,reason,recorded_at) VALUES(?,?,?,?,?)",
        &[
            json!(id.hex()),
            json!(principal),
            json!(decision),
            json!(reason),
            json!(number(c, "now")?),
        ],
    )?;
    Ok(json!({ "commit": id, "decision": decision }))
}
