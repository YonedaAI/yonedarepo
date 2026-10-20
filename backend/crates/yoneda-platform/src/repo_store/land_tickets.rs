//! Landing tickets: a landing that cannot move its branch directly joins the branch's queue
//! and is settled (landed or failed, with the reason) by whoever lands the batch it rides.
use super::land::gates;
use super::rows::{self, Settings, branch_ref};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub fn enqueue<S: SqlStore>(
    db: &S,
    c: &Value,
    principal: &str,
    settings: &Settings,
) -> Result<Value> {
    let refname = branch_ref(c)?;
    let commit = rows::recorded(db, &rows::object_id(c, "commit")?)?;
    let gate = gates(db, &commit.id, settings)?;
    if gate["ready"] != true {
        return Err(Error::new(
            "NOT_READY",
            format!("Commit cannot land yet: {gate}"),
        ));
    }
    let existing = db.query(
        "SELECT ticket FROM land_queue WHERE refname=? AND commit_id=? AND status='pending'",
        &[json!(refname), json!(commit.id.hex())],
    )?;
    if let Some(row) = existing.first() {
        return Ok(json!({ "ticket": row["ticket"], "queued": true }));
    }
    db.query(
        "INSERT INTO land_queue(refname,commit_id,principal,status,requested_at) VALUES(?,?,?,'pending',?)",
        &[json!(refname), json!(commit.id.hex()), json!(principal), json!(number(c, "now")?)],
    )?;
    let ticket = db.query("SELECT last_insert_rowid() AS t", &[])?[0]["t"].clone();
    Ok(json!({ "ticket": ticket, "queued": true }))
}

pub fn status<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let ticket = c["ticket"].as_i64().ok_or_else(|| bad("Missing ticket"))?;
    let row = db
        .query(
            "SELECT ticket,refname,commit_id,status,result FROM land_queue WHERE ticket=?",
            &[json!(ticket)],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", "Unknown landing ticket"))?;
    let mut result = row["result"]
        .as_str()
        .and_then(|r| serde_json::from_str::<Value>(r).ok());
    // A changeset landing names its Git commit once the projector has built it.
    if let Some(result) = result.as_mut().filter(|r| r.get("changeset").is_some()) {
        result["commit"] = db
            .query(
                "SELECT projected FROM changesets WHERE version=?",
                &[result["version"].clone()],
            )?
            .first()
            .map_or(Value::Null, |r| r["projected"].clone());
    }
    Ok(json!({
        "ticket": row["ticket"], "ref": row["refname"], "commit": row["commit_id"], "status": row["status"],
        "result": result,
    }))
}

pub(super) fn finish<S: SqlStore>(
    db: &S,
    ticket: &Value,
    status: &str,
    result: Value,
    now: i64,
) -> Result<()> {
    db.query(
        "UPDATE land_queue SET status=?,result=?,finished_at=? WHERE ticket=? AND status='pending'",
        &[
            json!(status),
            json!(result.to_string()),
            json!(now),
            ticket.clone(),
        ],
    )?;
    Ok(())
}
