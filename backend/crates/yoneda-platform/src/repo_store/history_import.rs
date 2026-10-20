//! Records history imported into the object store from an external Git remote (Artifacts
//! import). Commits arrive oldest first along the first-parent chain; each carries its
//! file-level changes, computed by the adapter from verified trees. History may be
//! truncated: parents that were not imported are kept in the commit (it is the real Git
//! object) but are invisible to graph walks.
use super::rows::{self, object_id};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId, txlog::PathTouch};

pub const IMPORT_PRINCIPAL: &str = "import";

pub fn record<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = object_id(c, "commit")?;
    // A retried step re-records the same commits; that is a no-op even after landing.
    if rows::commit_row(db, &id)?.is_some() {
        return Ok(json!({ "commit": id, "recorded": true, "already": true }));
    }
    if !db.query("SELECT name FROM refs LIMIT 1", &[])?.is_empty() {
        return Err(Error::new(
            "ALREADY_EXISTS",
            "History is only imported into an empty repository",
        ));
    }
    let tree = object_id(c, "tree")?;
    let parents: Vec<ObjectId> = c["parents"]
        .as_array()
        .ok_or_else(|| bad("parents must be a list"))?
        .iter()
        .map(|p| ObjectId::parse(p.as_str().unwrap_or_default()))
        .collect::<Result<_>>()?;
    let generation = match parents.first() {
        Some(parent) => rows::commit_row(db, parent)?.map_or(1, |p| p.generation + 1),
        None => 1,
    };
    let touches: Vec<PathTouch> = serde_json::from_value(c["touches"].clone())
        .map_err(|e| bad(&format!("Invalid touches: {e}")))?;
    if touches.len() > 100_000 {
        return Err(bad("Too many changed paths in one imported commit"));
    }
    let message: String = c["message"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(16_384)
        .collect();
    db.query(
        // Imported history was read from Artifacts, which holds it.
        "INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,origin,artifacts_at) VALUES(?,?,?,?,0,?,?,'[]',?,'import',?)",
        &[json!(id.hex()), json!(tree.hex()), json!(json!(parents).to_string()), json!(generation),
          json!(IMPORT_PRINCIPAL), json!(message), json!(number(c, "now")?), json!(number(c, "now")?)],
    )?;
    for touch in &touches {
        yoneda_core::validate_path(&touch.path)?;
        let encoded = serde_json::to_value(touch).map_err(|e| bad(&e.to_string()))?;
        db.query(
            "INSERT INTO commit_paths(commit_id,path,op,old_blob,new_blob) VALUES(?,?,?,?,?)",
            &[
                json!(id.hex()),
                encoded["path"].clone(),
                encoded["op"].clone(),
                encoded["old_blob"].clone(),
                encoded["new_blob"].clone(),
            ],
        )?;
    }
    Ok(json!({ "commit": id, "recorded": true, "generation": generation }))
}

/// Whether `id` was recorded by an import (and so may be landed without being a root).
pub fn imported<S: SqlStore>(db: &S, id: &ObjectId) -> Result<bool> {
    Ok(!db
        .query(
            "SELECT 1 AS x FROM commits WHERE id=? AND origin='import'",
            &[json!(id.hex())],
        )?
        .is_empty())
}
