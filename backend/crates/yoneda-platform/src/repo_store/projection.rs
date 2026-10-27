//! Protected branch refs in the object store (Artifacts) are a projection of this
//! authority's refs, so humans can `git clone` what landed. Every ref move records a target; the adapter
//! pushes each pending target with the last projected value as an expected-old lease and
//! reports back. A rejected lease is drift: surfaced, never overwritten.
use super::rows::corrupt;
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Result, git_object::ObjectId};

/// Called in the same transaction as the ref move; only protected refs and tags are
/// projected.
pub fn target<S: SqlStore>(
    db: &S,
    refname: &str,
    commit: &ObjectId,
    version: u64,
    now: i64,
) -> Result<()> {
    if !super::rows::protected(refname) && !super::rows::is_tag(refname) {
        return Ok(());
    }
    db.query(
        "INSERT INTO ref_projections(refname,target_commit,target_version,status,updated_at) VALUES(?,?,?,'pending',?) \
         ON CONFLICT(refname) DO UPDATE SET target_commit=excluded.target_commit,target_version=excluded.target_version,\
         status=CASE WHEN status='drift' THEN 'drift' ELSE 'pending' END,updated_at=excluded.updated_at",
        &[json!(refname), json!(commit.hex()), json!(version), json!(now)],
    )?;
    Ok(())
}

pub fn list<S: SqlStore>(db: &S) -> Result<Vec<Value>> {
    db.query(
        "SELECT refname,target_commit,target_version,projected_commit,projected_version,status,detail,updated_at FROM ref_projections ORDER BY refname",
        &[],
    )
}

/// Targets not yet projected (drifted refs wait for an owner to resolve them).
pub fn pending<S: SqlStore>(db: &S) -> Result<Value> {
    let rows = db.query(
        "SELECT refname,target_commit,target_version,projected_commit FROM ref_projections WHERE status='pending' ORDER BY refname",
        &[],
    )?;
    Ok(json!({ "pending": rows }))
}

pub fn result<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = string(c, "refname")?;
    let now = number(c, "now")?;
    let version = c["version"]
        .as_u64()
        .ok_or_else(|| bad("Missing version"))?;
    let row = db
        .query(
            "SELECT * FROM ref_projections WHERE refname=?",
            &[json!(refname)],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| bad("Unknown projected ref"))?;
    let target_version = row["target_version"]
        .as_u64()
        .ok_or_else(|| corrupt("projection"))?;
    match string(c, "outcome")?.as_str() {
        "ok" => {
            let commit = ObjectId::parse(&string(c, "commit")?)?;
            let projected = row["projected_version"].as_u64().unwrap_or(0);
            if version > target_version || version < projected {
                return Ok(json!({ "refname": refname, "ignored": true }));
            }
            let status = if version == target_version {
                "ok"
            } else {
                "pending"
            };
            db.query(
                "UPDATE ref_projections SET projected_commit=?,projected_version=?,status=?,detail=NULL,updated_at=? WHERE refname=?",
                &[json!(commit.hex()), json!(version), json!(status), json!(now), json!(refname)],
            )?;
            // The commits whose objects travelled with the ref are now held by Artifacts.
            if let Some(commits) = c["commits"].as_array() {
                super::store_lineage::stored(db, commits, false, now)?;
            }
            Ok(json!({ "refname": refname, "status": status }))
        }
        "drift" => {
            let detail = c["detail"]
                .as_str()
                .unwrap_or("Object store rejected the expected old value");
            db.query(
                "UPDATE ref_projections SET status='drift',detail=?,updated_at=? WHERE refname=?",
                &[
                    json!(detail.chars().take(500).collect::<String>()),
                    json!(now),
                    json!(refname),
                ],
            )?;
            Ok(json!({ "refname": refname, "status": "drift" }))
        }
        _ => Err(bad("outcome must be ok or drift")),
    }
}
