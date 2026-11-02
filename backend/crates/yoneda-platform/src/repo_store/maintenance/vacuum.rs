//! Pins: commits a vacuum of the commit shards keeps whatever their age.
use super::super::rows;
use crate::storage::{SqlStore, number, string};
use serde_json::{Value, json};
use yoneda_core::Result;

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
