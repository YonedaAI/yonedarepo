//! Batched landing: the branch's combiner submits every waiting landing in one call. Each
//! arrives as its commit shard's record (not adopted here) with its lander's credentials,
//! which are checked now against current access (scope, directory grant, automation
//! pause; a revoked token is refused), so a commit that began from a stale published head
//! can never land beyond its lander's rights. Path-disjoint landings append changesets
//! that share the batch's projected Git commit; landings on the same files are adopted
//! and queued for the merge path; members that would skew an earlier member wait for the
//! next batch.
use super::adopt::adopt_one;
use super::changesets::{Route, route_writing};
use super::land::{gates, write_entry_with};
use super::merging::BatchWrites;
use super::rows::{self, CommitRow, Settings, branch_ref, current_version};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{PathTouch, TxKind},
};

const BATCH: usize = 256;

fn commit_row(record: &Value) -> Result<CommitRow> {
    let row = &record["commit"];
    let ids: Vec<String> = serde_json::from_str(row["parents"].as_str().unwrap_or("[]"))
        .map_err(|_| bad("Record parents must be a list"))?;
    Ok(CommitRow {
        id: ObjectId::parse(&string(row, "id")?)?,
        tree: ObjectId::parse(&string(row, "tree")?)?,
        parents: ids
            .iter()
            .map(|i| ObjectId::parse(i))
            .collect::<Result<_>>()?,
        generation: row["generation"]
            .as_u64()
            .ok_or_else(|| bad("Missing generation"))?,
        base_version: row["base_version"]
            .as_u64()
            .ok_or_else(|| bad("Missing base_version"))?,
        principal: string(row, "principal")?,
        message: row["message"].as_str().unwrap_or_default().to_owned(),
        read_set: serde_json::from_str(row["read_set"].as_str().unwrap_or("[]"))
            .map_err(|_| bad("Record read set must be a list"))?,
    })
}

fn refused(error: Error) -> Value {
    json!({ "status": "failed", "code": error.code, "message": error.message })
}

/// `repo_land_submitted`: lands a batch of submitted landings on `ref` in one transaction.
pub fn land<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let refname = branch_ref(c)?;
    let items = c["items"]
        .as_array()
        .filter(|i| i.len() <= BATCH)
        .ok_or_else(|| bad("Submit at most 256 landings"))?;
    let batch_id = current_version(db)? + 1;
    let mut batch = BatchWrites::default();
    let mut results = Vec::new();
    for item in items {
        results.push(land_one(
            db, c, settings, &refname, item, batch_id, &mut batch,
        )?);
    }
    Ok(json!({ "items": results, "version": current_version(db)? }))
}

/// One member: access, gates and routing errors refuse it alone; storage errors abort the
/// whole batch (nothing is written before every check passed).
fn land_one<S: SqlStore>(
    db: &S,
    c: &Value,
    settings: &Settings,
    refname: &str,
    item: &Value,
    batch_id: u64,
    batch: &mut BatchWrites,
) -> Result<Value> {
    let records = item["records"]
        .as_array()
        .filter(|r| !r.is_empty())
        .ok_or_else(|| bad("A submitted landing needs its records"))?;
    let record = &records[records.len() - 1];
    let actor = match super::auth::actor(db, &item["credentials"], settings) {
        Ok(actor) if item["credentials"].get("_system").is_none() => actor,
        Ok(_) => {
            return Ok(refused(Error::new(
                "FORBIDDEN",
                "Landings are submitted for clients",
            )));
        }
        Err(e) => return Ok(refused(e)),
    };
    if let Err(e) = actor.require("land") {
        return Ok(refused(e));
    }
    if !actor.owner
        && let Err(e) = super::break_glass::refuse_if_paused(db)
    {
        return Ok(refused(e));
    }
    let commit = commit_row(record)?;
    let touches: Vec<PathTouch> = serde_json::from_value(record["paths"].clone())
        .map_err(|_| bad("Record paths are malformed"))?;
    if let Some(outside) = touches
        .iter()
        .find_map(|t| super::grants::require(&actor.grant, &t.path).err())
    {
        return Ok(refused(outside));
    }
    // A retried lander: its landing answers again.
    if let Some(row) = db
        .query(
            "SELECT version FROM landings WHERE commit_id=? AND refname=?",
            &[json!(commit.id.hex()), json!(refname)],
        )?
        .first()
    {
        return Ok(json!({ "status": "landed", "version": row["version"], "already": true }));
    }
    // Review classes travel with the record (semantic auto-approval reads them).
    if let Some(classes) = record.get("classes").filter(|v| !v.is_null()) {
        db.query(
            "INSERT INTO commit_classes(commit_id,overall,files,classified_at) VALUES(?,?,?,?) ON CONFLICT(commit_id) DO NOTHING",
            &[json!(commit.id.hex()), classes["overall"].clone(), classes["files"].clone(), c["now"].clone()],
        )?;
    }
    let gate = gates(db, &commit.id, settings)?;
    if gate["ready"] != true {
        return Ok(refused(Error::new(
            "NOT_READY",
            format!("Commit cannot land yet: {gate}"),
        )));
    }
    let writes: BTreeSet<String> = touches.iter().map(|t| t.path.clone()).collect();
    if !batch.admits(&commit.read_set, &writes) {
        return Ok(json!({ "status": "deferred" }));
    }
    match route_writing(db, refname, &commit, &writes, false)? {
        Route::Changeset | Route::FastForward(_) => {
            let entry = write_entry_with(
                db,
                c,
                TxKind::Changeset,
                refname,
                None,
                &commit,
                touches,
                &actor.principal,
            )?;
            db.query(
                "INSERT INTO changesets(version,refname,commit_id,landed_at,batch,tree,generation) VALUES(?,?,?,?,?,?,?)",
                &[json!(entry.version), json!(refname), json!(commit.id.hex()), json!(entry.committed_at_ms),
                  json!(batch_id), json!(commit.tree.hex()), json!(commit.generation)],
            )?;
            batch.accept(writes);
            Ok(json!({ "status": "landed", "version": entry.version }))
        }
        // The merge path needs the full commit: adopt the chain, queue it for merges. A
        // lander that sent only its commit's record sends the chain when asked.
        Route::Merge => {
            let first: Vec<String> =
                serde_json::from_str(records[0]["commit"]["parents"].as_str().unwrap_or("[]"))
                    .map_err(|_| bad("Record parents must be a list"))?;
            for parent in &first {
                if rows::commit_row(db, &ObjectId::parse(parent)?)?.is_none() {
                    return Ok(json!({ "status": "need_chain" }));
                }
            }
            let now = number(c, "now")?;
            for record in records {
                adopt_one(db, record, settings, now)?;
            }
            if let Some(row) = db
                .query(
                    "SELECT ticket FROM land_queue WHERE refname=? AND commit_id=? AND status='pending'",
                    &[json!(refname), json!(commit.id.hex())],
                )?
                .first()
            {
                return Ok(json!({ "status": "queued", "ticket": row["ticket"] }));
            }
            db.query(
                "INSERT INTO land_queue(refname,commit_id,principal,status,requested_at,slow) VALUES(?,?,?,'pending',?,1)",
                &[json!(refname), json!(commit.id.hex()), json!(actor.principal), json!(now)],
            )?;
            let ticket = db.query("SELECT last_insert_rowid() AS t", &[])?[0]["t"].clone();
            Ok(json!({ "status": "queued", "ticket": ticket }))
        }
        Route::Fail(error) => Ok(refused(error)),
    }
}
