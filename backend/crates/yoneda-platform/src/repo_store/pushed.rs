//! Commits pushed with stock Git, recorded under their own ids. The adapter has verified
//! the pack (every object hashed, every tree and blob a new commit names either in the pack
//! or already here) and either written the objects to R2, the store of record (one bundle
//! per batch of objects, indexed here first: `bundles`), or (a small push) sent them here
//! to be staged: accepted with the commit in one transaction and
//! written to R2 by the projector afterwards, as for commits built here. This store checks
//! what it can itself: each commit's bytes hash to its id, and its parents are recorded
//! (earlier in the same call counts). The base version is derived here, never taken from
//! the client. Recording moves no ref and writes no log entry. A pushed tip carries the
//! read set the push declared (`-o yoneda.reads=…`), which landing validates.
pub(super) mod bundles;

use super::auth::Actor;
use super::rows::{self, CommitRow, Settings, object_id};
use crate::storage::{SqlStore, bad, number};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{Commit, ObjectId, ObjectKind, hash_object, next_generation},
    txlog::PathTouch,
};

const COMMITS: usize = 500;
const TOUCHES: usize = 100_000;
/// First-parent steps searched for a landed ancestor before falling back to version 0.
const BASE_WALK: usize = 10_000;

/// `repo_record_pushed`: `commits` parents first, each `{commit, data_b64, touches,
/// objects: [{id, kind}], check, read_set?}`; `check` starts platform checks (the pushed
/// tips), which carry the push's declared reads. With
/// `staged`, every object also carries its `data_b64` and is staged with its commit;
/// `dispatch_objects` then says whether the adapter must ask for the drain to R2.
pub fn record<S: SqlStore>(db: &S, c: &Value, actor: &Actor, settings: &Settings) -> Result<Value> {
    actor.require("write")?;
    super::git_http::whole_repository(actor)?;
    let now = number(c, "now")?;
    let commits = c["commits"]
        .as_array()
        .filter(|list| !list.is_empty() && list.len() <= COMMITS)
        .ok_or_else(|| bad(&format!("commits must list 1-{COMMITS} pushed commits")))?;
    let staged = c["staged"] == true;
    let mut recorded = 0;
    let mut dispatch = false;
    let mut runs = Vec::new();
    for item in commits {
        let id = object_id(item, "commit")?;
        let reads = crate::platform_push_reads::read_set(
            serde_json::from_value::<Option<Vec<String>>>(item["read_set"].clone())
                .map_err(|_| bad("read_set must be a list of paths"))?
                .unwrap_or_default(),
        )?;
        match rows::commit_row(db, &id)? {
            None => {
                record_one(db, item, &actor.principal, &reads, now)?;
                if staged {
                    dispatch |= stage(db, &id, item, now)?;
                }
                recorded += 1;
            }
            Some(_) if !reads.is_empty() => add_reads(db, &id, &actor.principal, &reads)?,
            Some(_) => {}
        }
        if item["check"] == true {
            runs.extend(super::checks::request(
                db,
                &id,
                None,
                &actor.principal,
                settings,
                now,
            )?);
        }
    }
    Ok(json!({ "recorded": recorded, "check_runs": runs, "dispatch_objects": dispatch }))
}

/// Stages a pushed commit's objects (each checked against its id) and accepts them: reads
/// fall back to these copies until the projector has written them to R2.
fn stage<S: SqlStore>(db: &S, id: &ObjectId, item: &Value, now: i64) -> Result<bool> {
    let mut objects = Vec::new();
    for object in item["objects"]
        .as_array()
        .ok_or_else(|| bad("objects must be a list"))?
    {
        let kind = match object["kind"].as_str() {
            Some("commit") => ObjectKind::Commit,
            Some("tree") => ObjectKind::Tree,
            Some("blob") => ObjectKind::Blob,
            _ => return Err(bad("Object kind must be commit, tree or blob")),
        };
        let data = STANDARD
            .decode(object["data_b64"].as_str().unwrap_or_default())
            .map_err(|_| bad("data_b64 is not base64"))?;
        let listed = object_id(object, "id")?;
        if hash_object(kind, &data) != listed {
            return Err(Error::new(
                "GIT_OBJECT_INVALID",
                format!("Object bytes do not hash to {listed}"),
            ));
        }
        objects.push((listed, kind, data));
    }
    let refs: Vec<(ObjectId, ObjectKind, &[u8])> = objects
        .iter()
        .map(|(i, k, d)| (*i, *k, d.as_slice()))
        .collect();
    if !super::staging::stage(db, id, &refs)? {
        return Err(Error::new(
            "TOO_LARGE",
            "This pushed commit is too large to stage; write its objects to the store first",
        ));
    }
    super::staging::accept(db, id, now)
}

/// A commit pushed again with declared reads keeps the union of its reads: declaring more
/// only makes landing stricter. Only its own pusher may add to them (anyone else could
/// block it from landing), and never once it has landed (its log entry is written).
fn add_reads<S: SqlStore>(db: &S, id: &ObjectId, principal: &str, reads: &[String]) -> Result<()> {
    let row = db
        .query(
            "SELECT read_set FROM commits WHERE id=? AND origin='push' AND principal=? \
             AND NOT EXISTS (SELECT 1 FROM landings WHERE commit_id=commits.id)",
            &[json!(id.hex()), json!(principal)],
        )?
        .into_iter()
        .next();
    let Some(row) = row else { return Ok(()) };
    let held: Vec<String> = serde_json::from_str(row["read_set"].as_str().unwrap_or("[]"))
        .map_err(|_| rows::corrupt("read set"))?;
    let merged = crate::platform_push_reads::read_set(held.into_iter().chain(reads.to_vec()))?;
    db.query(
        "UPDATE commits SET read_set=? WHERE id=?",
        &[json!(json!(merged).to_string()), json!(id.hex())],
    )?;
    Ok(())
}

fn record_one<S: SqlStore>(
    db: &S,
    item: &Value,
    principal: &str,
    reads: &[String],
    now: i64,
) -> Result<()> {
    let id = object_id(item, "commit")?;
    let data = STANDARD
        .decode(item["data_b64"].as_str().unwrap_or_default())
        .map_err(|_| bad("data_b64 is not base64"))?;
    if hash_object(ObjectKind::Commit, &data) != id {
        return Err(Error::new(
            "GIT_OBJECT_INVALID",
            format!("Commit bytes do not hash to {id}"),
        ));
    }
    let commit = Commit::decode(&data)?;
    let parents = commit.parents()?;
    let parent_rows = parents
        .iter()
        .map(|p| rows::recorded(db, p))
        .collect::<Result<Vec<_>>>()?;
    let generation = next_generation(&parent_rows.iter().map(|r| r.generation).collect::<Vec<_>>());
    let base_version = base_version(db, parent_rows.first())?;
    let touches: Vec<PathTouch> = serde_json::from_value(item["touches"].clone())
        .map_err(|e| bad(&format!("Invalid touches: {e}")))?;
    if touches.len() > TOUCHES {
        return Err(Error::new(
            "TOO_LARGE",
            "Too many changed paths in one pushed commit",
        ));
    }
    let message: String = String::from_utf8_lossy(commit.message())
        .chars()
        .take(16_384)
        .collect();
    db.query(
        // The objects are in R2 (or staged here, below); Artifacts gets them with the first
        // protected ref that includes this commit (commit_objects lists them until then).
        "INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,origin,hidden_ref,artifacts_at) VALUES(?,?,?,?,?,?,?,?,?,'push',0,NULL)",
        &[json!(id.hex()), json!(commit.tree()?.hex()), json!(json!(parents).to_string()), json!(generation),
          json!(base_version), json!(principal), json!(message), json!(json!(reads).to_string()), json!(now)],
    )?;
    for chunk in touches.chunks(16) {
        let mut params = Vec::with_capacity(chunk.len() * 6);
        for touch in chunk {
            yoneda_core::validate_path(&touch.path)?;
            let encoded = serde_json::to_value(touch).map_err(|e| bad(&e.to_string()))?;
            params.extend([
                json!(id.hex()),
                encoded["path"].clone(),
                encoded["op"].clone(),
                encoded["old_blob"].clone(),
                encoded["new_blob"].clone(),
                encoded["mode"].clone(),
            ]);
        }
        let rows = vec!["(?,?,?,?,?,?)"; chunk.len()].join(",");
        db.query(
            &format!(
                "INSERT INTO commit_paths(commit_id,path,op,old_blob,new_blob,mode) VALUES{rows}"
            ),
            &params,
        )?;
    }
    let objects = item["objects"]
        .as_array()
        .ok_or_else(|| bad("objects must be a list"))?;
    if !objects.iter().any(|o| o["id"] == json!(id.hex())) {
        return Err(bad("A pushed commit must list its own object"));
    }
    for chunk in objects.chunks(33) {
        let mut params = Vec::with_capacity(chunk.len() * 3);
        for object in chunk {
            let kind = object["kind"].as_str().unwrap_or_default();
            if !matches!(kind, "commit" | "tree" | "blob") {
                return Err(bad("Object kind must be commit, tree or blob"));
            }
            params.extend([
                json!(id.hex()),
                json!(object_id(object, "id")?.hex()),
                json!(kind),
            ]);
        }
        let rows = vec!["(?,?,?)"; chunk.len()].join(",");
        db.query(
            &format!(
                "INSERT INTO commit_objects(commit_id,id,kind) VALUES{rows} ON CONFLICT DO NOTHING"
            ),
            &params,
        )?;
    }
    Ok(())
}

/// The log version a pushed commit is based on: the first landing of its nearest
/// first-parent ancestor that landed anywhere (a parent pushed earlier passes on its own
/// base). Too old is safe: landing then checks more of the log; too new could hide a
/// concurrent change, so anything unknown falls back to 0.
fn base_version<S: SqlStore>(db: &S, parent: Option<&CommitRow>) -> Result<u64> {
    let Some(first) = parent else { return Ok(0) };
    let mut at = first.id;
    for _ in 0..BASE_WALK {
        let landed = db.query(
            "SELECT MIN(version) AS v FROM landings WHERE commit_id=?",
            &[json!(at.hex())],
        )?;
        if let Some(version) = landed.first().and_then(|r| r["v"].as_u64()) {
            return Ok(version);
        }
        let Some(row) = db
            .query(
                "SELECT origin,base_version,parents FROM commits WHERE id=?",
                &[json!(at.hex())],
            )?
            .into_iter()
            .next()
        else {
            return Ok(0);
        };
        if row["origin"] == "push" {
            return Ok(row["base_version"].as_u64().unwrap_or(0));
        }
        let parents: Vec<String> = serde_json::from_str(row["parents"].as_str().unwrap_or("[]"))
            .map_err(|_| rows::corrupt("parents"))?;
        match parents.first() {
            Some(next) => at = yoneda_core::git_object::ObjectId::parse(next)?,
            None => return Ok(0),
        }
    }
    Ok(0)
}
