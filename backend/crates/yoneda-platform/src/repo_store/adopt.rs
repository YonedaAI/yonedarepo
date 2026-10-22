//! Commits built outside the authority. `begin` authorizes a write and hands the adapter
//! what stateless creation needs (the parent and base version); the commit is recorded in
//! its commit shard. The authority adopts it only when it first needs it (a landing, a
//! check, a review, a read by id): the adapter copies the shard record here, parents
//! first, so history, merge bases and gates stay local.
use super::rows::{self, Settings, branch_ref, current_version, object_id};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

/// The parent and base version of a commit on `refname`: its settled head; in an empty
/// repository (no branch at all), none: the first commit is a root, which landing makes
/// the branch.
pub(super) fn base_on_branch<S: SqlStore>(
    db: &S,
    refname: &str,
) -> Result<(Option<ObjectId>, u64)> {
    let (head, version) = super::changesets::settled_head(db, refname)?;
    if head.is_some() || db.query("SELECT 1 AS x FROM refs LIMIT 1", &[])?.is_empty() {
        return Ok((head, version));
    }
    Err(Error::new("NOT_FOUND", format!("{refname} does not exist")))
}

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
            // New work builds on the last projected head, at the version it reflects.
            base_on_branch(db, &refname)?
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
    // A chain arrives parents first in one call (`records`), or one commit (`record`).
    if let Some(records) = c["records"].as_array() {
        let mut adopted = Vec::new();
        for record in records {
            adopted.push(adopt_one(db, record, settings, number(c, "now")?)?);
        }
        let last = adopted
            .last()
            .cloned()
            .ok_or_else(|| bad("records is empty"))?;
        let runs: Vec<Value> = adopted
            .iter()
            .flat_map(|a| a["check_runs"].as_array().cloned().unwrap_or_default())
            .collect();
        return Ok(json!({ "commit": last["commit"], "adopted": true, "check_runs": runs }));
    }
    adopt_one(db, &c["record"], settings, number(c, "now")?)
}

pub(super) fn adopt_one<S: SqlStore>(
    db: &S,
    record: &Value,
    settings: &Settings,
    now: i64,
) -> Result<Value> {
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
    db.query(
        "INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,hidden_ref,artifacts_at) VALUES(?,?,?,?,?,?,?,?,?,0,NULL)",
        &[json!(id.hex()), row["tree"].clone(), json!(json!(parents).to_string()), row["generation"].clone(),
          row["base_version"].clone(), json!(principal), row["message"].clone(), row["read_set"].clone(), row["recorded_at"].clone()],
    )?;
    for path in record["paths"].as_array().into_iter().flatten() {
        db.query(
            "INSERT INTO commit_paths(commit_id,path,op,old_blob,new_blob,mode) VALUES(?,?,?,?,?,?)",
            &[
                json!(id.hex()),
                path["path"].clone(),
                path["op"].clone(),
                path["old_blob"].clone(),
                path["new_blob"].clone(), path["mode"].clone(),
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
