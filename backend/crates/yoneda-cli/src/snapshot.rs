//! Bringing a platform commit's tree into the local repository through the API (no
//! `git clone` credential needed): the missing trees and blobs are fetched by id, each
//! verified against its id, and added as one pack per batch. The local commit made on
//! it has the platform's exact tree.
use crate::api::Api;
use crate::error::{Error, Result};
use crate::git::Git;
use base64::Engine;
use serde_json::{Value, json};
use std::collections::HashSet;
use yoneda_core::git_object::{
    FileMode, ObjectId, ObjectKind, TreeEntry, encode_tree, hash_object, write_pack,
};

/// Ids per `POST /objects` request (the platform takes up to 10 000).
const REQUEST_OBJECTS: usize = 2_000;
/// Fetched bytes held before they are written out as a pack.
const PACK_BYTES: usize = 64 * 1024 * 1024;

/// Imports `commit` as a local commit on `parent` with `message`; returns its id.
pub async fn import(
    api: &Api,
    git: &Git,
    commit: &str,
    parent: Option<&str>,
    message: &str,
) -> Result<String> {
    let info = api.commit(commit).await?;
    fetch_tree(api, git, &info.tree).await?;
    git.commit_tree(&info.tree, parent, message)
}

fn mode(kind: &str) -> Result<FileMode> {
    Ok(match kind {
        "tree" => FileMode::Tree,
        "blob" => FileMode::Blob,
        "exec" => FileMode::Executable,
        "symlink" => FileMode::Symlink,
        "gitlink" => FileMode::Gitlink,
        other => return Err(Error::new(format!("unknown tree entry type {other:?}"))),
    })
}

fn object_id(value: &Value, field: &str) -> Result<ObjectId> {
    let hex = value[field].as_str().unwrap_or_default();
    ObjectId::parse(hex).map_err(|e| Error::new(format!("bad object id {hex:?}: {}", e.message)))
}

/// An object's kind and Git bytes, plus the ids (and kinds) of what it references.
type Verified = (ObjectKind, Vec<u8>, Vec<(String, ObjectKind)>);

/// A fetched object as verified Git bytes, plus the ids of what it references.
fn verified(object: &Value) -> Result<Verified> {
    let id = object_id(object, "id")?;
    let (kind, data, refs) = match object["kind"].as_str() {
        Some("tree") => {
            let entries = object["entries"]
                .as_array()
                .ok_or_else(|| Error::new(format!("tree {id} has no entries")))?
                .iter()
                .map(|e| {
                    Ok(TreeEntry {
                        name: e["name"].as_str().unwrap_or_default().to_owned(),
                        mode: mode(e["type"].as_str().unwrap_or_default())?,
                        id: object_id(e, "id")?,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let refs = entries
                .iter()
                .filter_map(|e| match e.mode {
                    FileMode::Tree => Some((e.id.hex(), ObjectKind::Tree)),
                    FileMode::Gitlink => None,
                    _ => Some((e.id.hex(), ObjectKind::Blob)),
                })
                .collect();
            let data = encode_tree(&entries)
                .map_err(|e| Error::new(format!("tree {id}: {}", e.message)))?;
            (ObjectKind::Tree, data, refs)
        }
        Some("blob") => {
            let data = base64::engine::general_purpose::STANDARD
                .decode(object["data_b64"].as_str().unwrap_or_default())
                .map_err(|_| Error::new(format!("blob {id} is not base64")))?;
            (ObjectKind::Blob, data, Vec::new())
        }
        other => {
            return Err(Error::new(format!(
                "unexpected object kind {other:?} for {id}"
            )));
        }
    };
    if hash_object(kind, &data) != id {
        return Err(Error::new(format!(
            "the platform sent {id} with different content"
        )));
    }
    Ok((kind, data, refs))
}

/// Fetches `wanted` objects (paging through the platform's response budget).
async fn fetch(api: &Api, wanted: &[(String, ObjectKind)]) -> Result<Vec<Value>> {
    let (fetched, missing) = request(api, wanted, false).await?;
    if !missing.is_empty() {
        return Err(Error::new(format!(
            "the platform is missing objects: {missing:?}"
        )));
    }
    Ok(fetched)
}

/// The served objects among `wanted` and the ids the platform does not have. `raw` asks
/// for commits as their exact Git content.
async fn request(
    api: &Api,
    wanted: &[(String, ObjectKind)],
    raw: bool,
) -> Result<(Vec<Value>, Vec<String>)> {
    let mut fetched = Vec::with_capacity(wanted.len());
    let mut absent = Vec::new();
    for batch in wanted.chunks(REQUEST_OBJECTS) {
        let ids: Vec<Value> = batch
            .iter()
            .map(|(id, kind)| json!({ "id": id, "kind": kind.name() }))
            .collect();
        let mut after = 0u64;
        loop {
            let page = api
                .post_read(
                    "/objects",
                    &json!({ "objects": ids, "after": after, "raw": raw }),
                )
                .await?;
            absent.extend(
                page["missing"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|m| m.as_str().map(str::to_owned)),
            );
            fetched.extend(page["objects"].as_array().cloned().unwrap_or_default());
            match page["next"].as_u64() {
                Some(next) if next > after => after = next,
                Some(_) => return Err(Error::new("the platform's object paging did not advance")),
                None => break,
            }
        }
    }
    Ok((fetched, absent))
}

/// A platform commit as served with `raw`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Served {
    /// The exact Git content (verified against its id).
    Exact(Vec<u8>),
    /// Tree and parents only: history the platform holds in its object store alone.
    Shape(CommitShape),
}

/// Each of `ids` (all of which the platform must have) as exact commits where it can.
pub async fn commits(api: &Api, ids: &[String]) -> Result<Vec<(String, Served)>> {
    let wanted: Vec<(String, ObjectKind)> = ids
        .iter()
        .map(|id| (id.clone(), ObjectKind::Commit))
        .collect();
    let (served, missing) = request(api, &wanted, true).await?;
    if !missing.is_empty() {
        return Err(Error::new(format!(
            "the platform is missing commits: {missing:?}"
        )));
    }
    served
        .iter()
        .map(|object| {
            let id = object_id(object, "id")?;
            let Some(b64) = object["data_b64"].as_str() else {
                return Ok((id.hex(), Served::Shape(shape(object)?)));
            };
            let data = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|_| Error::new(format!("commit {id} is not base64")))?;
            if hash_object(ObjectKind::Commit, &data) != id {
                return Err(Error::new(format!(
                    "the platform sent {id} with different content"
                )));
            }
            Ok((id.hex(), Served::Exact(data)))
        })
        .collect()
}

/// The commits among `ids` that the platform has.
pub async fn present(api: &Api, ids: &[String]) -> Result<HashSet<String>> {
    let wanted: Vec<(String, ObjectKind)> = ids
        .iter()
        .map(|id| (id.clone(), ObjectKind::Commit))
        .collect();
    let (_, missing) = request(api, &wanted, false).await?;
    let missing: HashSet<String> = missing.into_iter().collect();
    Ok(ids
        .iter()
        .filter(|id| !missing.contains(*id))
        .cloned()
        .collect())
}

/// Adds `objects` to the local repository as one pack (all or nothing).
pub fn write_objects(git: &Git, objects: Vec<(ObjectKind, Vec<u8>)>) -> Result<()> {
    write(git, &mut { objects })
}

/// Fetches every object under `root` that the local repository lacks.
pub async fn fetch_tree(api: &Api, git: &Git, root: &str) -> Result<()> {
    fetch_trees(api, git, &[root.to_owned()]).await
}

/// Fetches every object under any of `roots` that the local repository lacks, as one
/// walk (shared subtrees are fetched once) written as one pack per 64 MiB.
pub async fn fetch_trees(api: &Api, git: &Git, roots: &[String]) -> Result<()> {
    let mut seen: HashSet<String> = roots.iter().cloned().collect();
    let first = seen.iter().map(|r| (r.clone(), ObjectKind::Tree)).collect();
    let mut wanted = missing(git, first)?;
    let mut pending: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
    let mut pending_bytes = 0usize;
    while !wanted.is_empty() {
        let mut next = Vec::new();
        for object in fetch(api, &wanted).await? {
            let (kind, data, refs) = verified(&object)?;
            next.extend(refs.into_iter().filter(|(id, _)| seen.insert(id.clone())));
            pending_bytes += data.len();
            pending.push((kind, data));
        }
        if pending_bytes > PACK_BYTES {
            write(git, &mut pending)?;
            pending_bytes = 0;
        }
        wanted = missing(git, next)?;
    }
    write(git, &mut pending)
}

/// A platform commit's tree and parents (what `/objects` serves for a commit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitShape {
    pub id: String,
    pub tree: String,
    pub parents: Vec<String>,
}

/// The tree and parents of each of `ids`, through `/objects` (works for imported
/// history too, which has no platform commit record).
pub async fn commit_shapes(api: &Api, ids: &[String]) -> Result<Vec<CommitShape>> {
    let wanted: Vec<(String, ObjectKind)> = ids
        .iter()
        .map(|id| (id.clone(), ObjectKind::Commit))
        .collect();
    fetch(api, &wanted).await?.iter().map(shape).collect()
}

fn shape(object: &Value) -> Result<CommitShape> {
    let parents = object["parents"]
        .as_array()
        .ok_or_else(|| Error::new("a commit object has no parents"))?
        .iter()
        .map(|p| Ok(text_id(p)?.hex()))
        .collect::<Result<Vec<_>>>()?;
    Ok(CommitShape {
        id: object_id(object, "id")?.hex(),
        tree: object_id(object, "tree")?.hex(),
        parents,
    })
}

fn text_id(value: &Value) -> Result<ObjectId> {
    let hex = value.as_str().unwrap_or_default();
    ObjectId::parse(hex).map_err(|e| Error::new(format!("bad object id {hex:?}: {}", e.message)))
}

fn missing(git: &Git, candidates: Vec<(String, ObjectKind)>) -> Result<Vec<(String, ObjectKind)>> {
    let ids: Vec<String> = candidates.iter().map(|(id, _)| id.clone()).collect();
    let absent: HashSet<String> = git.missing(&ids)?.into_iter().collect();
    Ok(candidates
        .into_iter()
        .filter(|(id, _)| absent.contains(id))
        .collect())
}

fn write(git: &Git, pending: &mut Vec<(ObjectKind, Vec<u8>)>) -> Result<()> {
    if pending.is_empty() {
        return Ok(());
    }
    let objects: Vec<(ObjectKind, &[u8])> =
        pending.iter().map(|(k, d)| (*k, d.as_slice())).collect();
    let pack =
        write_pack(&objects).map_err(|e| Error::new(format!("building a pack: {}", e.message)))?;
    git.unpack(&pack)?;
    pending.clear();
    Ok(())
}
