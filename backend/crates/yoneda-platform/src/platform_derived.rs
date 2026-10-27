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
    search::{Segment, build_segment, grep},
};

const MAX_PARTITION_FILES: usize = 20_000;

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

/// A partition's segment, with paths relative to the partition root: the key is the tree
/// id alone, so the segment must not depend on the directory the tree sits at.
pub fn index_partition(c: &Value) -> Result<Value> {
    let trees = supplied_trees(c)?;
    let tree = ObjectId::parse(&string(c, "tree")?)?;
    let listed = match files(tree, c["shallow"] == true, &trees) {
        Ok(listed) => listed,
        Err(need) => return Ok(json!({ "need_trees": need })),
    };
    if listed.len() > MAX_PARTITION_FILES {
        return Ok(json!({ "too_large": true, "files": listed.len() }));
    }
    let mut need = BTreeSet::new();
    let mut contents = Vec::with_capacity(listed.len());
    for (path, id) in listed {
        match verified_blob(c, &id)? {
            Some(data) => contents.push((path, id, data)),
            None => {
                need.insert(id);
            }
        }
    }
    if !need.is_empty() {
        return Ok(json!({ "need_blobs": need }));
    }
    Ok(json!({ "segment": build_segment(&contents) }))
}

pub fn search_segment(c: &Value) -> Result<Value> {
    let segment: Segment =
        serde_json::from_value(c["segment"].clone()).map_err(|_| bad("Invalid segment"))?;
    let prefix = c["prefix"].as_str().unwrap_or_default();
    Ok(json!({ "candidates": segment.candidates(prefix, &string(c, "query")?) }))
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
