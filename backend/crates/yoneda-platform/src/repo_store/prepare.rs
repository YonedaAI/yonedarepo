//! Builds a commit on the server. The adapter supplies existing trees by id; this module
//! asks for exactly the directories on changed paths (one round per depth), verifies every
//! supplied tree against its id, and returns the pack to push before the commit is recorded
//! (or stages the objects here when the caller can defer the push).
pub(crate) mod build;
pub(crate) mod changes;
use super::rows::{self, CommitRow, Settings, branch_ref, current_version, object_id};
use super::tree_cache;
use crate::storage::{SqlStore, bad, number};
use base64::{Engine, engine::general_purpose::STANDARD};
use build::{Parent, build, frontier, objects_json, supplied_trees};
use changes::{changes, known_blob};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, encode_tree, write_pack},
    transport::{hidden_ref, receive_pack_request},
};

const PREPARED_TTL_MS: i64 = 60 * 60 * 1000;

/// The parent and base version: given, or a branch's head at the current version (saving
/// the caller a snapshot round trip). Callers pin what the first round returns.
fn base<S: SqlStore>(db: &S, c: &Value) -> Result<(Option<ObjectId>, u64)> {
    if c.get("parent").is_none_or(Value::is_null) && c["ref"].is_string() {
        let refname = branch_ref(c)?;
        return super::adopt::base_on_branch(db, &refname);
    }
    let base_version = c["base_version"]
        .as_u64()
        .ok_or_else(|| bad("Missing base_version"))?;
    if base_version > current_version(db)? {
        return Err(Error::new(
            "STALE_INPUT",
            "Base version is newer than the log",
        ));
    }
    match c.get("parent").filter(|p| !p.is_null()) {
        Some(_) => Ok((Some(object_id(c, "parent")?), base_version)),
        None => Ok((None, base_version)),
    }
}

pub fn prepare<S: SqlStore>(
    db: &S,
    c: &Value,
    principal: &str,
    settings: &Settings,
) -> Result<Value> {
    let now = number(c, "now")?;
    let (parent, base_version) = base(db, c)?;
    let parent = parent.map(|id| rows::recorded(db, &id)).transpose()?;
    let root = parent.as_ref().map(|p| p.tree);
    let changes = changes(c, &settings.policy.secret_allow)?;
    let mut trees = supplied_trees(c)?;
    let supplied = trees
        .0
        .iter()
        .map(|(id, entries)| Ok((*id, encode_tree(entries)?)))
        .collect::<Result<Vec<_>>>()?;
    tree_cache::keep(db, &supplied)?;
    let paths: Vec<&str> = changes.iter().map(|ch| ch.path.as_str()).collect();
    // Walk as deep as remembered trees reach; ask the adapter only for the rest.
    let missing = loop {
        let missing = frontier(root, &paths, &trees);
        if missing.is_empty() || !tree_cache::fill(db, &mut trees.0, &missing)? {
            break missing;
        }
    };
    if !missing.is_empty() {
        return Ok(json!({
            "need_trees": missing.iter().map(ObjectId::hex).collect::<Vec<_>>(),
            "parent": parent.as_ref().map(|p| p.id), "base_version": base_version,
        }));
    }
    let mut merges = Vec::new();
    if let Some(one) = c.get("merge_parent").filter(|p| !p.is_null()) {
        merges.push(ObjectId::parse(one.as_str().unwrap_or_default())?);
    }
    for extra in c["merge_parents"].as_array().into_iter().flatten() {
        merges.push(ObjectId::parse(extra.as_str().unwrap_or_default())?);
    }
    let merges = merges
        .iter()
        .map(|id| rows::recorded(db, id).map(|r| as_parent(&r)))
        .collect::<Result<Vec<_>>>()?;
    let parent = parent.as_ref().map(as_parent);
    let built = build(c, parent.as_ref(), &merges, &changes, &trees, now, &|id| {
        known_blob(db, id)
    })?;
    tree_cache::keep(db, &built.trees)?;
    let id = built.id;
    let hidden = hidden_ref(&id);
    let (parents, generation, touches, read_set, message) = (
        &built.parents,
        built.generation,
        &built.touches,
        &built.read_set,
        &built.message,
    );
    let prepared = json!({
        "tree": built.root, "parents": parents, "generation": generation,
        "base_version": base_version, "touches": touches, "read_set": read_set, "message": message,
    });
    db.query(
        "INSERT INTO prepared_commits(commit_id,principal,payload,expires_at) VALUES(?,?,?,?) \
         ON CONFLICT(commit_id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE principal=excluded.principal",
        &[json!(id.hex()), json!(principal), json!(prepared.to_string()), json!(now + PREPARED_TTL_MS)],
    )?;
    super::staging::expire(db, now)?;
    let mut result = json!({
        "commit": id, "tree": built.root, "parents": parents, "touches": touches,
        "hidden_ref": hidden, "base_version": base_version,
        // Structured copies for the adapter's write-through object cache (tier 2), so it
        // never parses Git formats itself.
        "objects": objects_json(&built)?,
    });
    let objects = built.object_refs();
    // A caller that can defer the push asks to stage; larger commits are still pushed.
    if c["stage"] == true && super::staging::stage(db, &id, &objects)? {
        result["staged"] = json!(true);
    } else {
        let pack = write_pack(&objects.iter().map(|(_, k, d)| (*k, *d)).collect::<Vec<_>>())?;
        result["push_b64"] =
            json!(STANDARD.encode(receive_pack_request(&hidden, None, id, &pack)?));
        // The commit's raw bytes for the store of record (R2), which serves clients the
        // exact object; the store behind the push may keep only its tree and parents.
        result["commit_b64"] = json!(STANDARD.encode(objects[0].2));
    }
    Ok(result)
}

fn as_parent(row: &CommitRow) -> Parent {
    Parent {
        id: row.id,
        tree: row.tree,
        generation: row.generation,
    }
}
