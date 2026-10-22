//! A commit shard: where commits built by stateless compute are recorded, chosen by
//! commit id so concurrent writers spread over shards instead of queueing on the
//! repository authority. It holds commit records, changesets, review classes, symbol
//! writes and staged objects (until R2 holds them), and no refs: a commit reaches the
//! authority (and its refs, checks and reviews) by adoption, when the authority first
//! needs it. Only the platform adapter calls it, after the authority authorized the write.
use crate::repo_store::{migration::migrate_with, staging};
use crate::storage::{SqlStore, bad, number, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{Commit, ObjectId, ObjectKind, hash_object},
};

const MIGRATIONS: [(i64, &str); 2] = [
    (1, include_str!("migrations/commit_store/0001_commits.sql")),
    (
        2,
        include_str!("migrations/commit_store/0002_path_modes.sql"),
    ),
];

pub fn migrate_commit_store<S: SqlStore>(db: &S) -> Result<()> {
    migrate_with(db, "commit_store_migrations", &MIGRATIONS)
}

/// One command against a migrated shard.
pub fn execute_commit_store<S: SqlStore>(db: &S, command: Value) -> Result<Value> {
    if command["_system"] != "commits" {
        return Err(Error::new(
            "FORBIDDEN",
            "Commit shards are reached through the platform only",
        ));
    }
    let owned = db.clone();
    db.transaction(Box::new(move || {
        let c = &command;
        match string(c, "op")?.as_str() {
            "store_record" => record(&owned, c),
            "store_commit" => read(&owned, c),
            "store_objects_pending" => staging::pending(&owned),
            "store_objects_projected" => staging::projected(&owned, c),
            "store_staged_objects" => staged(&owned, c),
            "store_status" => staging::status(&owned),
            "store_vacuum_scan" => vacuum_scan(&owned, c),
            "store_vacuum_delete" => vacuum_delete(&owned, c),
            "store_forget" => forget(&owned, c),
            op => Err(Error::new("UNKNOWN_OP", format!("Unknown shard op {op}"))),
        }
    }))
}

/// Records a built commit with its staged objects, verified against their ids and the
/// commit object; idempotent per commit id.
fn record<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = ObjectId::parse(&string(c, "commit")?)?;
    if !db
        .query("SELECT 1 FROM commits WHERE id=?", &[json!(id.hex())])?
        .is_empty()
    {
        return Ok(json!({ "commit": id, "already": true, "dispatch_objects": false }));
    }
    let mut objects = Vec::new();
    for object in c["objects"]
        .as_array()
        .ok_or_else(|| bad("objects must be a list"))?
    {
        let kind = match object["kind"].as_str() {
            Some("commit") => ObjectKind::Commit,
            Some("tree") => ObjectKind::Tree,
            Some("blob") => ObjectKind::Blob,
            _ => return Err(bad("Objects are commits, trees or blobs")),
        };
        let data = STANDARD
            .decode(object["data_b64"].as_str().unwrap_or_default())
            .map_err(|_| bad("data_b64 is not base64"))?;
        objects.push((hash_object(kind, &data), kind, data));
    }
    let header = objects
        .iter()
        .find(|(oid, kind, _)| *oid == id && *kind == ObjectKind::Commit)
        .map(|(_, _, data)| Commit::decode(data))
        .ok_or_else(|| bad("The objects do not include the commit"))??;
    let parents = header.parents()?;
    if json!(header.tree()?) != c["tree"] || json!(parents) != c["parents"] {
        return Err(Error::new(
            "OBJECT_INVALID",
            "The commit object differs from its record",
        ));
    }
    let refs: Vec<(ObjectId, ObjectKind, &[u8])> = objects
        .iter()
        .map(|(i, k, d)| (*i, *k, d.as_slice()))
        .collect();
    if !staging::stage(db, &id, &refs)? {
        return Err(Error::new(
            "TOO_LARGE",
            "Commit is too large for a shard; record it with the authority",
        ));
    }
    let now = number(c, "now")?;
    db.query(
        "INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)",
        &[json!(id.hex()), c["tree"].clone(), json!(json!(parents).to_string()), json!(number(c, "generation")?),
          json!(number(c, "base_version")?), json!(string(c, "principal")?), json!(c["message"].as_str().unwrap_or_default()),
          json!(c["read_set"].to_string()), json!(now)],
    )?;
    for touch in c["touches"].as_array().into_iter().flatten() {
        db.query(
            "INSERT INTO commit_paths(commit_id,path,op,old_blob,new_blob,mode) VALUES(?,?,?,?,?,?)",
            &[
                json!(id.hex()),
                touch["path"].clone(),
                touch["op"].clone(),
                touch["old_blob"].clone(),
                touch["new_blob"].clone(), touch["mode"].clone(),
            ],
        )?;
    }
    if let Some(classes) = c.get("classes").filter(|v| !v.is_null()) {
        db.query(
            "INSERT INTO commit_classes(commit_id,overall,files) VALUES(?,?,?)",
            &[
                json!(id.hex()),
                json!(string(classes, "overall")?),
                json!(classes["files"].to_string()),
            ],
        )?;
    }
    for touch in c["symbols"].as_array().into_iter().flatten() {
        db.query(
            "INSERT INTO commit_symbols(commit_id,path,symbols) VALUES(?,?,?)",
            &[
                json!(id.hex()),
                touch["path"].clone(),
                json!(touch["symbols"].to_string()),
            ],
        )?;
    }
    let dispatch = staging::accept(db, &id, now)?;
    Ok(json!({ "commit": id, "recorded": true, "dispatch_objects": dispatch }))
}

/// A commit's full record, for adoption by the authority.
fn read<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = ObjectId::parse(&string(c, "commit")?)?;
    let key = [json!(id.hex())];
    let row = db
        .query("SELECT * FROM commits WHERE id=?", &key)?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", format!("Commit {id} is not in this shard")))?;
    Ok(json!({
        "commit": row,
        "paths": db.query("SELECT path,op,old_blob,new_blob,mode FROM commit_paths WHERE commit_id=? ORDER BY path", &key)?,
        "classes": db.query("SELECT overall,files FROM commit_classes WHERE commit_id=?", &key)?.into_iter().next(),
        "symbols": db.query("SELECT path,symbols FROM commit_symbols WHERE commit_id=? ORDER BY path", &key)?,
        "objects": db.query("SELECT id,kind FROM commit_objects WHERE commit_id=? ORDER BY id", &key)?,
    }))
}

/// Staged objects; with `with_record`, also the commit's record (null when this shard does
/// not hold it): the projector reads a landed commit's objects and record in one call.
fn staged<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let mut out = staging::read(db, c)?;
    if c["with_record"] == true {
        out["record"] = match read(db, c) {
            Ok(record) => record,
            Err(e) if e.code == "NOT_FOUND" => Value::Null,
            Err(e) => return Err(e),
        };
    }
    Ok(out)
}

const VACUUM_ROWS: i64 = 5000;

/// Vacuum input: commits recorded before `before` (with their parents), and the parents of
/// every newer commit. The adapter keeps every ancestor of a newer commit, across shards.
/// Commits whose objects are still on their way to R2 are never offered.
fn vacuum_scan<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let before = number(c, "before")?;
    let old = db.query(
        "SELECT id,parents FROM commits WHERE recorded_at<? AND id NOT IN (SELECT commit_id FROM object_projections) ORDER BY recorded_at LIMIT ?",
        &[json!(before), json!(VACUUM_ROWS)],
    )?;
    let young = db.query(
        "SELECT parents FROM commits WHERE recorded_at>=? LIMIT ?",
        &[json!(before), json!(VACUUM_ROWS)],
    )?;
    let parents = |row: &Value| -> Vec<Value> {
        serde_json::from_str(row["parents"].as_str().unwrap_or("[]")).unwrap_or_default()
    };
    Ok(json!({
        "old": old.iter().map(|r| json!({ "id": r["id"], "parents": parents(r) })).collect::<Vec<_>>(),
        "young_parents": young.iter().flat_map(parents).collect::<Vec<_>>(),
    }))
}

/// Forgets expired commits (records, changesets, derived rows, object lists). Objects in R2
/// stay: they are content-addressed and may be shared with commits that live on.
fn vacuum_delete<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let mut deleted = 0;
    for id in c["ids"]
        .as_array()
        .ok_or_else(|| bad("ids must be a list"))?
    {
        let id = ObjectId::parse(id.as_str().unwrap_or_default())?;
        let pending = db.query(
            "SELECT 1 FROM object_projections WHERE commit_id=?",
            &[json!(id.hex())],
        )?;
        if !pending.is_empty() {
            continue;
        }
        for table in [
            "commit_paths",
            "commit_classes",
            "commit_symbols",
            "commit_objects",
            "staged_objects",
        ] {
            db.query(
                &format!("DELETE FROM {table} WHERE commit_id=?"),
                &[json!(id.hex())],
            )?;
        }
        db.query("DELETE FROM commits WHERE id=?", &[json!(id.hex())])?;
        deleted += 1;
    }
    Ok(json!({ "deleted": deleted }))
}

/// Drops the records of commits the authority adopted (it serves them now), so the next
/// adoption walk stops at them. Staged objects stay until their R2 write.
fn forget<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    for id in c["ids"]
        .as_array()
        .ok_or_else(|| bad("ids must be a list"))?
    {
        let id = ObjectId::parse(id.as_str().unwrap_or_default())?;
        for table in [
            "commit_paths",
            "commit_classes",
            "commit_symbols",
            "commit_objects",
        ] {
            db.query(
                &format!("DELETE FROM {table} WHERE commit_id=?"),
                &[json!(id.hex())],
            )?;
        }
        db.query("DELETE FROM commits WHERE id=?", &[json!(id.hex())])?;
    }
    Ok(json!({ "forgotten": true }))
}

#[cfg(test)]
mod tests;
