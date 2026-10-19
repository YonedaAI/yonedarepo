//! Review classes recorded per commit by the platform classifier (adapter compute), read
//! by landing gates and the review UI.
use super::rows;
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::Result;

pub fn record<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = rows::recorded(db, &rows::object_id(c, "commit")?)?.id;
    let overall = string(c, "overall")?;
    let files = c["files"]
        .as_array()
        .ok_or_else(|| bad("files must be a list"))?;
    db.query(
        "INSERT INTO commit_classes(commit_id,overall,files,classified_at) VALUES(?,?,?,?) ON CONFLICT(commit_id) DO NOTHING",
        &[json!(id.hex()), json!(overall), json!(json!(files).to_string()), json!(number(c, "now")?)],
    )?;
    Ok(json!({ "commit": id, "overall": overall }))
}

pub fn for_commit<S: SqlStore>(db: &S, id: &yoneda_core::git_object::ObjectId) -> Result<Value> {
    Ok(db
        .query("SELECT overall,files FROM commit_classes WHERE commit_id=?", &[json!(id.hex())])?
        .first()
        .map(|r| json!({ "overall": r["overall"], "files": serde_json::from_str::<Value>(r["files"].as_str().unwrap_or("[]")).unwrap_or(Value::Null) }))
        .unwrap_or(Value::Null))
}
