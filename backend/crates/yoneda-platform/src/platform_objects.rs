//! JSON forms of Git trees shared by the platform authority and stateless compute.
//! Trees arriving from adapters are untrusted: each must hash to the id it is filed under.
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use yoneda_core::{Error, Result, git_object::*};

pub fn mode(kind: &str) -> Result<FileMode> {
    Ok(match kind {
        "tree" => FileMode::Tree,
        "blob" => FileMode::Blob,
        "exec" => FileMode::Executable,
        "symlink" => FileMode::Symlink,
        "gitlink" => FileMode::Gitlink,
        _ => return Err(bad("Unknown tree entry type")),
    })
}

pub fn entry_type(mode: FileMode) -> &'static str {
    match mode {
        FileMode::Tree => "tree",
        FileMode::Blob => "blob",
        FileMode::Executable => "exec",
        FileMode::Symlink => "symlink",
        FileMode::Gitlink => "gitlink",
    }
}

pub fn entries_json(entries: &[TreeEntry]) -> Value {
    json!(
        entries
            .iter()
            .map(|e| json!({"name": e.name, "type": entry_type(e.mode), "id": e.id}))
            .collect::<Vec<_>>()
    )
}

/// Parses `c.trees` (`{id: [{name,type,id}]}`), verifying every tree against its id.
pub fn supplied_trees(c: &Value) -> Result<HashMap<ObjectId, Vec<TreeEntry>>> {
    let mut trees = HashMap::new();
    for (id, entries) in c["trees"].as_object().into_iter().flatten() {
        let id = ObjectId::parse(id)?;
        let entries = entries
            .as_array()
            .ok_or_else(|| bad("Tree entries must be an array"))?
            .iter()
            .map(|e| {
                Ok(TreeEntry {
                    name: string(e, "name")?,
                    mode: mode(&string(e, "type")?)?,
                    id: ObjectId::parse(&string(e, "id")?)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        if hash_object(ObjectKind::Tree, &encode_tree(&entries)?) != id {
            return Err(Error::new(
                "TREE_INVALID",
                format!("Supplied tree does not match {id}"),
            ));
        }
        trees.insert(id, entries);
    }
    Ok(trees)
}

/// One tree an adapter read: raw Git bytes (`data_b64`) or `{name, type, id}` entries,
/// either way checked against `id`.
pub fn supplied_tree(id: &ObjectId, tree: &Value) -> Result<Vec<TreeEntry>> {
    let entries = match tree.get("data_b64").and_then(Value::as_str) {
        Some(data) => decode_tree(
            &STANDARD
                .decode(data)
                .map_err(|_| bad("Tree data is not base64"))?,
        )?,
        None => tree["entries"]
            .as_array()
            .ok_or_else(|| bad("A supplied tree needs data_b64 or entries"))?
            .iter()
            .map(|e| {
                Ok(TreeEntry {
                    name: string(e, "name")?,
                    mode: mode(&string(e, "type")?)?,
                    id: ObjectId::parse(&string(e, "id")?)?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
    };
    if hash_object(ObjectKind::Tree, &encode_tree(&entries)?) != *id {
        return Err(Error::new(
            "TREE_INVALID",
            format!("Supplied tree does not match {id}"),
        ));
    }
    Ok(entries)
}

/// Structured object form shared by the R2 cache tier and the R2 object store, so
/// adapters never parse Git formats themselves.
pub fn object_json(id: ObjectId, kind: ObjectKind, data: &[u8]) -> Result<Value> {
    Ok(match kind {
        ObjectKind::Tree => {
            json!({"id": id, "kind": "tree", "entries": entries_json(&decode_tree(data)?)})
        }
        ObjectKind::Commit => {
            let commit = Commit::decode(data)?;
            json!({"id": id, "kind": "commit", "tree": commit.tree()?, "parents": commit.parents()?})
        }
        _ => json!({"id": id, "kind": kind.name(), "data_b64": STANDARD.encode(data)}),
    })
}

/// The trees on the paths to `changes` in `root` (the directories a commit rewrote).
pub fn new_trees(
    root: ObjectId,
    changes: &[TreeChange],
    trees: &HashMap<ObjectId, Vec<TreeEntry>>,
) -> Vec<ObjectId> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    if !changes.is_empty() && seen.insert(root) {
        found.push(root);
    }
    for change in changes {
        let mut at = root;
        let parts: Vec<&str> = change.path.split('/').collect();
        for dir in &parts[..parts.len() - 1] {
            let next = trees
                .get(&at)
                .and_then(|entries| entries.iter().find(|e| e.name == *dir && e.mode.is_tree()));
            let Some(entry) = next else { break };
            at = entry.id;
            if seen.insert(at) {
                found.push(at);
            }
        }
    }
    found
}
