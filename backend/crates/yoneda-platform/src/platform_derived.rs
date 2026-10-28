//! Derived-data compute (search partitions, grep, blame), stateless in the Worker. Every
//! object an op reads is supplied by the adapter and verified here first.
use crate::platform_objects::supplied_trees;
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use yoneda_core::{
    Error, Result,
    blame::blame,
    git_object::{FileMode, ObjectId, ObjectKind, TreeEntry, hash_object},
    search::{MAX_INDEXED_BYTES, StoredSegment, build_segment, grep},
};

/// Files one directory may list for indexing (its index is built in chunks).
const MAX_PARTITION_FILES: usize = 200_000;

pub(crate) fn verified_blob(c: &Value, id: &ObjectId) -> Result<Option<Vec<u8>>> {
    let Some(encoded) = c["blobs"].get(id.hex()).and_then(Value::as_str) else {
        return Ok(None);
    };
    let data = STANDARD
        .decode(encoded)
        .map_err(|_| bad("Blob content is not base64"))?;
    if hash_object(ObjectKind::Blob, &data) != *id {
        return Err(Error::new(
            "BLOB_INVALID",
            format!("Supplied blob does not match {id}"),
        ));
    }
    Ok(Some(data))
}

/// Partitions of a commit's root tree: one per top-level directory (keyed by its tree id,
/// so identical subtrees share an index wherever they sit) plus one for top-level files.
pub fn plan(c: &Value) -> Result<Value> {
    let trees = supplied_trees(c)?;
    let root = ObjectId::parse(&string(c, "root")?)?;
    let Some(entries) = trees.get(&root) else {
        return Ok(json!({ "need_trees": [root] }));
    };
    let mut partitions: Vec<Value> = entries
        .iter()
        .filter(|e| e.mode == FileMode::Tree)
        .map(|e| json!({ "prefix": e.name, "tree": e.id, "key": e.id, "shallow": false }))
        .collect();
    let files: Vec<&TreeEntry> = entries
        .iter()
        .filter(|e| e.mode != FileMode::Tree)
        .collect();
    if !files.is_empty() {
        let listing: String = files
            .iter()
            .map(|e| format!("{} {}\n", e.name, e.id))
            .collect();
        partitions.push(json!({
            "prefix": "", "tree": root, "shallow": true,
            "key": format!("files-{}", yoneda_core::digest(listing.as_bytes())),
        }));
    }
    Ok(json!({ "partitions": partitions }))
}

/// Files under a partition, relative to its root, or the trees still needed to list them.
fn files(
    tree: ObjectId,
    shallow: bool,
    trees: &HashMap<ObjectId, Vec<TreeEntry>>,
) -> std::result::Result<Vec<(String, ObjectId)>, BTreeSet<ObjectId>> {
    let mut out = Vec::new();
    let mut need = BTreeSet::new();
    let mut stack = vec![(String::new(), tree)];
    while let Some((dir, id)) = stack.pop() {
        let Some(entries) = trees.get(&id) else {
            need.insert(id);
            continue;
        };
        for e in entries {
            let path = if dir.is_empty() {
                e.name.clone()
            } else {
                format!("{dir}/{}", e.name)
            };
            match e.mode {
                FileMode::Tree if !shallow => stack.push((path, e.id)),
                FileMode::Blob | FileMode::Executable => out.push((path, e.id)),
                _ => {}
            }
        }
    }
    if need.is_empty() { Ok(out) } else { Err(need) }
}

/// `partition_files`: a partition's files (`[{path, id}]`, paths relative to its root),
/// or the trees still needed to list them. The adapter indexes them in chunks.
pub fn partition_files(c: &Value) -> Result<Value> {
    let trees = supplied_trees(c)?;
    let tree = ObjectId::parse(&string(c, "tree")?)?;
    let listed = match files(tree, c["shallow"] == true, &trees) {
        Ok(listed) => listed,
        Err(need) => return Ok(json!({ "need_trees": need })),
    };
    if listed.len() > MAX_PARTITION_FILES {
        return Err(Error::new(
            "TOO_LARGE",
            format!("A directory of more than {MAX_PARTITION_FILES} files is not indexed"),
        ));
    }
    let files: Vec<Value> = listed
        .into_iter()
        .map(|(path, id)| json!({ "path": path, "id": id }))
        .collect();
    Ok(json!({ "files": files }))
}

/// `index_files`: the segment of a chunk of a partition's files (`files: [{path, id}]`),
/// asking for their content. `sizes` (`{id: bytes}`, what the adapter knows) lists a file
/// too large to index by path, unread; the segment is the same either way.
pub fn index_files(c: &Value) -> Result<Value> {
    let listed = c["files"]
        .as_array()
        .ok_or_else(|| bad("files must be a list"))?;
    let mut need = BTreeSet::new();
    let mut contents = Vec::with_capacity(listed.len());
    for file in listed {
        let (path, id) = (
            string(file, "path")?,
            ObjectId::parse(&string(file, "id")?)?,
        );
        let size = c["sizes"].get(id.hex()).and_then(Value::as_u64);
        if size.is_some_and(|n| n > MAX_INDEXED_BYTES as u64) {
            contents.push((path, id, None));
            continue;
        }
        match verified_blob(c, &id)? {
            Some(data) => contents.push((path, id, Some(data))),
            None => {
                need.insert(id);
            }
        }
    }
    if !need.is_empty() {
        return Ok(json!({ "need_blobs": need }));
    }
    let segment = build_segment(&contents).encode()?;
    Ok(json!({ "segment_b64": STANDARD.encode(segment) }))
}

/// `search_segment`: of a stored segment (`segment_b64`) under `prefix`, the files that may
/// hold `query` and the files whose content is not searched, with why.
pub fn search_segment(c: &Value) -> Result<Value> {
    let bytes = STANDARD
        .decode(string(c, "segment_b64")?)
        .map_err(|_| bad("segment_b64 is not base64"))?;
    let segment = StoredSegment::open(&bytes)?;
    let prefix = c["prefix"].as_str().unwrap_or_default();
    let at = |path: &str| match prefix {
        "" => path.to_owned(),
        _ => format!("{prefix}/{path}"),
    };
    let unindexed: Vec<Value> = segment
        .files
        .iter()
        .filter(|f| !f.indexed)
        .map(|f| json!({ "path": at(&f.path), "reason": f.skipped.as_deref().unwrap_or("not indexed") }))
        .collect();
    Ok(json!({
        "candidates": segment.candidates(prefix, &string(c, "query")?)?,
        "unindexed": unindexed,
    }))
}

pub fn grep_blob(c: &Value) -> Result<Value> {
    let id = ObjectId::parse(&string(c, "id")?)?;
    let data = verified_blob(c, &id)?.ok_or_else(|| bad("Blob not supplied"))?;
    let max = c["max"].as_u64().unwrap_or(20).min(200) as usize;
    Ok(json!({ "lines": grep(&data, &string(c, "query")?, c["ignore_case"] == true, max) }))
}

/// Blame from (commit, blob id) versions oldest first; blobs are verified.
pub fn blame_versions(c: &Value) -> Result<Value> {
    let versions = c["versions"]
        .as_array()
        .ok_or_else(|| bad("versions must be a list"))?;
    let mut need = BTreeSet::new();
    let mut history = Vec::with_capacity(versions.len());
    for version in versions {
        let commit = ObjectId::parse(&string(version, "commit")?)?;
        let id = ObjectId::parse(&string(version, "blob")?)?;
        match verified_blob(c, &id)? {
            Some(data) => history.push((commit, data)),
            None => {
                need.insert(id);
            }
        }
    }
    if !need.is_empty() {
        return Ok(json!({ "need_blobs": need }));
    }
    Ok(json!({ "lines": blame(&history) }))
}

#[cfg(test)]
#[path = "platform_derived_tests.rs"]
mod tests;
