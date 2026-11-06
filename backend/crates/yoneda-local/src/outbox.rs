//! Staged objects (docs/local-landing-budget.md): the platform's merge commits are staged
//! in the authority (`repo_prepare_commit` with `stage`), which holds them durably in its
//! SQLite file, so a landing writes nothing to the store while it holds the branch's
//! landing lock. `drain` then writes every pending commit's objects to the store in one
//! pack and reports them projected (the engine's object outbox, as the cloud's projector
//! drains it to R2); refs move only to commits the store holds (`project`). Until drained,
//! reads fall back to the authority's staged copies (`Objects`).
//!
//! `YONEDA_LOCAL_STAGE=off` turns staging off: each merge commit then reaches the store as
//! a receive-pack request inside the lock, as before.
use crate::authority::{Authority, Cred};
use crate::layout::local_error;
use crate::service::Service;
use crate::store::Store;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use yoneda_core::{
    Result,
    git_object::{ObjectId, ObjectKind, hash_object, write_pack},
};

/// The platform role that reads and settles the object outbox.
const PROJECTOR: Cred = Cred::System("projection");
/// Ids one staged read may name (the engine's limit).
const READ_IDS: usize = 64;

/// Whether merge commits are staged (the default).
pub fn staging() -> bool {
    std::env::var("YONEDA_LOCAL_STAGE").as_deref() != Ok("off")
}

/// The store, then the authority's staged copies for what it does not hold yet.
pub struct Objects<'a> {
    pub store: &'a Store,
    pub authority: &'a Authority,
}

impl Objects<'_> {
    pub fn read(&self, ids: &[ObjectId]) -> Result<HashMap<ObjectId, (ObjectKind, Vec<u8>)>> {
        let mut found = self.store.read(ids)?;
        let missing: Vec<ObjectId> = ids
            .iter()
            .filter(|id| !found.contains_key(id))
            .copied()
            .collect();
        for chunk in missing.chunks(READ_IDS) {
            let staged = self.authority.call(
                &PROJECTOR,
                json!({ "op": "repo_staged_objects", "ids": chunk, "raw": true }),
            )?;
            for object in staged["objects"].as_array().into_iter().flatten() {
                let (id, kind, data) = decoded(object)?;
                found.insert(id, (kind, data));
            }
        }
        Ok(found)
    }
}

/// `{id, kind, data_b64}` → the object, checked against its id.
fn decoded(object: &Value) -> Result<(ObjectId, ObjectKind, Vec<u8>)> {
    let id = ObjectId::parse(object["id"].as_str().unwrap_or_default())?;
    let kind = match object["kind"].as_str() {
        Some("commit") => ObjectKind::Commit,
        Some("tree") => ObjectKind::Tree,
        Some("blob") => ObjectKind::Blob,
        Some("tag") => ObjectKind::Tag,
        _ => return Err(local_error("A staged object has no kind")),
    };
    let data = STANDARD
        .decode(object["data_b64"].as_str().unwrap_or_default())
        .map_err(|_| local_error("A staged object is unreadable"))?;
    if hash_object(kind, &data) != id {
        return Err(local_error("A staged object does not match its id"));
    }
    Ok((id, kind, data))
}

/// Writes every pending staged commit's objects to the store, one pack per round, and
/// reports them projected. One drain runs at a time; a caller that waited finds what
/// landed meanwhile and drains that too.
pub fn drain(svc: &Service) -> Result<()> {
    let _draining = svc.draining.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        let pending = svc
            .authority
            .call(&PROJECTOR, json!({ "op": "repo_objects_pending" }))?;
        let commits = pending["commits"].as_array().cloned().unwrap_or_default();
        if commits.is_empty() {
            return Ok(());
        }
        let mut objects: BTreeMap<ObjectId, (ObjectKind, Vec<u8>)> = BTreeMap::new();
        for commit in &commits {
            for object in commit["objects"].as_array().into_iter().flatten() {
                let (id, kind, data) = decoded(object)?;
                objects.insert(id, (kind, data));
            }
        }
        let listed: Vec<(ObjectKind, &[u8])> =
            objects.values().map(|(k, d)| (*k, d.as_slice())).collect();
        let written = write_pack(&listed).and_then(|pack| svc.store.index_pack(&pack));
        let results: Vec<Value> = commits
            .iter()
            .map(|c| match &written {
                Ok(()) => json!({ "commit": c["commit"], "outcome": "ok" }),
                Err(e) => {
                    json!({ "commit": c["commit"], "outcome": "failed", "detail": e.message })
                }
            })
            .collect();
        svc.authority.call(
            &PROJECTOR,
            json!({ "op": "repo_objects_projected", "results": results }),
        )?;
        written?;
    }
}
