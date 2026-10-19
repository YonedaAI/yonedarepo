//! JSON forms of Git trees shared by the platform authority and stateless compute.
//! Trees arriving from adapters are untrusted: each must hash to the id it is filed under.
use crate::storage::{bad, string};
use serde_json::{Value, json};
use std::collections::HashMap;
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
