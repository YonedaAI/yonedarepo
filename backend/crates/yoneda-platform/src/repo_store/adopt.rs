//! Commits built outside the authority. `begin` authorizes a write and hands the adapter
//! what stateless creation needs (the parent and base version); the commit is recorded in
//! its commit shard. The authority adopts it only when it first needs it (a landing, a
//! check, a review, a read by id): the adapter copies the shard record here, parents
//! first, so history, merge bases and gates stay local.
use super::rows::{self, Settings, branch_ref, current_version, object_id};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

/// Authorizes a commit by `principal` and returns its parent (a branch head at the current
/// version, or the given parent when this store has it) and the base version.
pub fn begin<S: SqlStore>(
    db: &S,
    c: &Value,
    principal: &str,
    settings: &Settings,
) -> Result<Value> {
    let (parent, base_version) =
        if c.get("parent").is_none_or(Value::is_null) && c["ref"].is_string() {
            let refname = branch_ref(c)?;
            let head = rows::ref_value(db, &refname)?
                .ok_or_else(|| Error::new("NOT_FOUND", format!("{refname} does not exist")))?;
            (Some(head), current_version(db)?)
        } else {
            let base_version = c["base_version"].as_u64().unwrap_or(0);
            if base_version > current_version(db)? {
                return Err(Error::new(
                    "STALE_INPUT",
                    "Base version is newer than the log",
                ));
            }
            let parent = c
                .get("parent")
                .filter(|p| !p.is_null())
                .map(|_| object_id(c, "parent"))
                .transpose()?;
            (parent, base_version)
        };
    let row = parent
        .map(|id| rows::commit_row(db, &id))
        .transpose()?
        .flatten();
    let here = row.is_some();
    Ok(json!({
        "principal": principal,
        "parent": row.map(|r| json!({ "id": r.id, "tree": r.tree, "generation": r.generation })),
        // The parent lives in its commit shard until something here needs it.
        "parent_elsewhere": parent.is_some() && !here,
        "parent_id": parent,
        "base_version": base_version,
        "object_store": settings.object_store,
        "runners": !settings.policy.runners.is_empty(),
    }))
}

/// Copies a shard record into this store (its parents must already be here) and starts
/// its platform checks, as recording does.
pub fn adopt<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let record = &c["record"];
    let row = &record["commit"];
    let id = ObjectId::parse(&string(row, "id")?)?;
    if rows::commit_row(db, &id)?.is_some() {
        return Ok(json!({ "commit": id, "adopted": true, "already": true }));
    }
    let parents: Vec<ObjectId> = serde_json::from_str(row["parents"].as_str().unwrap_or("[]"))
        .map_err(|_| bad("parents must be a list of ids"))?;
    for parent in &parents {
        rows::recorded(db, parent)?;
    }
    let principal = string(row, "principal")?;
    let now = number(c, "now")?;
    db.query(
        "INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,hidden_ref,artifacts_at) VALUES(?,?,?,?,?,?,?,?,?,0,NULL)",
        &[json!(id.hex()), row["tree"].clone(), json!(json!(parents).to_string()), row["generation"].clone(),
          row["base_version"].clone(), json!(principal), row["message"].clone(), row["read_set"].clone(), row["recorded_at"].clone()],
    )?;
    for path in record["paths"].as_array().into_iter().flatten() {
        db.query(
            "INSERT INTO commit_paths(commit_id,path,op,old_blob,new_blob) VALUES(?,?,?,?,?)",
            &[
                json!(id.hex()),
                path["path"].clone(),
                path["op"].clone(),
                path["old_blob"].clone(),
                path["new_blob"].clone(),
            ],
        )?;
    }
    if let Some(classes) = record.get("classes").filter(|v| !v.is_null()) {
        db.query(
            "INSERT INTO commit_classes(commit_id,overall,files,classified_at) VALUES(?,?,?,?) ON CONFLICT(commit_id) DO NOTHING",
            &[json!(id.hex()), classes["overall"].clone(), classes["files"].clone(), json!(now)],
        )?;
    }
    for touch in record["symbols"].as_array().into_iter().flatten() {
        db.query(
            "INSERT INTO commit_symbols(commit_id,path,symbols,derived_at) VALUES(?,?,?,?) ON CONFLICT(commit_id,path) DO NOTHING",
            &[json!(id.hex()), touch["path"].clone(), touch["symbols"].clone(), json!(now)],
        )?;
    }
    for object in record["objects"].as_array().into_iter().flatten() {
        db.query(
            "INSERT INTO commit_objects(commit_id,id,kind) VALUES(?,?,?) ON CONFLICT DO NOTHING",
            &[
                json!(id.hex()),
                object["id"].clone(),
                object["kind"].clone(),
            ],
        )?;
    }
    let runs = super::checks::request(db, &id, None, &principal, settings, now)?;
    Ok(json!({ "commit": id, "adopted": true, "check_runs": runs }))
}
