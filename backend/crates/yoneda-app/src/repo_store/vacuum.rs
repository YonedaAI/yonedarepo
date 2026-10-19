//! Vacuum: the only maintenance the platform does (Scion S5). Every recorded commit keeps
//! a hidden ref in the object store so it cannot be collected while it may still land.
//! A hidden ref is released when the commit is safely reachable from a projected branch,
//! or when unlanded work expired. Pinned commits and in-flight work are never released.
use super::rows;
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Result, git_object::ObjectId};

pub const DEFAULT_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub fn plan<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let now = number(c, "now")?;
    let retention = c["retention_ms"]
        .as_i64()
        .unwrap_or(DEFAULT_RETENTION_MS)
        .max(60_000);
    // Covered: landed at or before the version its branch is projected at, in sync.
    let covered = db.query(
        "SELECT DISTINCT c.id FROM commits c JOIN landings l ON l.commit_id=c.id \
         JOIN ref_projections p ON p.refname=l.refname AND p.status='ok' AND l.version<=p.projected_version \
         WHERE c.hidden_ref_deleted_at IS NULL AND c.origin='platform' \
         AND c.id NOT IN (SELECT commit_id FROM pins) LIMIT 500",
        &[],
    )?;
    // Expired: never landed anywhere, old, unpinned, and nothing still waits on it.
    let expired = db.query(
        "SELECT c.id FROM commits c WHERE c.hidden_ref_deleted_at IS NULL AND c.origin='platform' \
         AND c.recorded_at<?1 AND c.id NOT IN (SELECT commit_id FROM landings) \
         AND c.id NOT IN (SELECT commit_id FROM pins) \
         AND c.id NOT IN (SELECT commit_id FROM land_queue WHERE status='pending') \
         AND c.id NOT IN (SELECT commit_id FROM check_runs WHERE status IN ('queued','running') AND created_at>=?1) \
         AND c.id NOT IN (SELECT repair_commit FROM repairs WHERE repair_commit IS NOT NULL) \
         AND NOT EXISTS (SELECT 1 FROM bisects b WHERE b.status='running' AND b.candidates LIKE '%' || c.id || '%') \
         LIMIT 500",
        &[json!(now - retention)],
    )?;
    let ids = |rows: Vec<Value>| {
        rows.into_iter()
            .map(|r| r["id"].clone())
            .collect::<Vec<_>>()
    };
    Ok(json!({ "covered": ids(covered), "expired": ids(expired) }))
}

pub fn done<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let now = number(c, "now")?;
    let mut released = 0;
    for id in c["commits"]
        .as_array()
        .ok_or_else(|| bad("commits must be a list"))?
    {
        let id = ObjectId::parse(id.as_str().unwrap_or_default())?;
        db.query(
            "UPDATE commits SET hidden_ref_deleted_at=? WHERE id=? AND hidden_ref_deleted_at IS NULL",
            &[json!(now), json!(id.hex())],
        )?;
        released += 1;
    }
    Ok(json!({ "released": released }))
}

pub fn pin<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let id = rows::recorded(db, &rows::object_id(c, "commit")?)?.id;
    if c["unpin"] == true {
        db.query("DELETE FROM pins WHERE commit_id=?", &[json!(id.hex())])?;
        return Ok(json!({ "commit": id, "pinned": false }));
    }
    db.query(
        "INSERT INTO pins(commit_id,reason,pinned_by,pinned_at) VALUES(?,?,?,?) ON CONFLICT(commit_id) DO NOTHING",
        &[json!(id.hex()), json!(string(c, "reason")?), json!(principal), json!(number(c, "now")?)],
    )?;
    Ok(json!({ "commit": id, "pinned": true }))
}
