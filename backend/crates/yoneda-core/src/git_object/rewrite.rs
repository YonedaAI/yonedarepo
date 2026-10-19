//! Incremental tree rewrite: only directories on changed paths are read and re-encoded,
//! so commit cost scales with the change, not the repository.
use super::{
    FileMode, ObjectId, ObjectKind, TreeEntry, encode_tree, hash_object, invalid,
    tree::validate_name,
};
use crate::Result;
use std::collections::BTreeMap;

/// Supplies existing trees by id (Artifacts, a cache, or a test map).
pub trait TreeSource {
    fn tree(&self, id: &ObjectId) -> Result<Vec<TreeEntry>>;
}

/// Sets `path` to a non-tree entry, or deletes it when `target` is `None`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathChange {
    pub path: String,
    pub target: Option<(FileMode, ObjectId)>,
}

/// The new root plus every newly encoded tree (to upload before the commit references them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rewrite {
    pub root: ObjectId,
    pub trees: Vec<(ObjectId, Vec<u8>)>,
}

type Target = Option<(FileMode, ObjectId)>;
type Pending<'a> = Vec<(&'a [&'a str], Target)>;
/// Per child name: its own change (if any) and changes nested beneath it.
type Group<'a> = (Option<Target>, Pending<'a>);

pub fn rewrite_tree(
    base: Option<ObjectId>,
    changes: &[PathChange],
    source: &impl TreeSource,
) -> Result<Rewrite> {
    let split: Vec<Vec<&str>> = changes
        .iter()
        .map(|change| {
            let parts: Vec<&str> = change.path.split('/').collect();
            parts.iter().try_for_each(|part| validate_name(part))?;
            if matches!(change.target, Some((FileMode::Tree, _))) {
                return Err(invalid("Changes set files; directories follow from paths"));
            }
            Ok(parts)
        })
        .collect::<Result<_>>()?;
    let mut seen = std::collections::BTreeSet::new();
    if !changes.iter().all(|c| seen.insert(c.path.as_str())) {
        return Err(invalid("A path appears twice in one change"));
    }
    let pending: Pending = split
        .iter()
        .zip(changes)
        .map(|(parts, change)| (parts.as_slice(), change.target))
        .collect();
    let mut trees = Vec::new();
    let root = match apply(base, pending, source, &mut trees)? {
        Some(root) => root,
        None => store(&[], &mut trees)?,
    };
    Ok(Rewrite { root, trees })
}

fn apply(
    dir: Option<ObjectId>,
    pending: Pending,
    source: &impl TreeSource,
    out: &mut Vec<(ObjectId, Vec<u8>)>,
) -> Result<Option<ObjectId>> {
    let mut entries: BTreeMap<String, TreeEntry> = match dir {
        Some(id) => source
            .tree(&id)?
            .into_iter()
            .map(|e| (e.name.clone(), e))
            .collect(),
        None => BTreeMap::new(),
    };
    let mut groups: BTreeMap<&str, Group> = BTreeMap::new();
    for (parts, target) in pending {
        let group = groups.entry(parts[0]).or_default();
        if parts.len() == 1 {
            group.0 = Some(target);
        } else {
            group.1.push((&parts[1..], target));
        }
    }
    for (name, (leaf, nested)) in groups {
        let existing = entries.get(name).cloned();
        if !nested.is_empty() {
            let existing_tree = match (&existing, leaf) {
                (_, Some(Some(_))) => {
                    return Err(invalid(format!(
                        "{name:?} is set as a file and used as a directory"
                    )));
                }
                (Some(e), Some(None)) if !e.mode.is_tree() => None,
                (Some(e), None) if !e.mode.is_tree() => {
                    return Err(invalid(format!(
                        "{name:?} is a file; delete it before adding children"
                    )));
                }
                (Some(e), _) => Some(e.id),
                (None, _) => None,
            };
            match apply(existing_tree, nested, source, out)? {
                Some(id) => entries.insert(name.to_owned(), entry(name, FileMode::Tree, id)),
                None => entries.remove(name),
            };
            continue;
        }
        match (leaf.flatten(), existing) {
            (Some(_), Some(e)) if e.mode.is_tree() => {
                return Err(invalid(format!("{name:?} is a directory, not a file")));
            }
            (Some((mode, id)), _) => {
                entries.insert(name.to_owned(), entry(name, mode, id));
            }
            (None, Some(e)) if !e.mode.is_tree() => {
                entries.remove(name);
            }
            (None, _) => return Err(invalid(format!("Cannot delete missing file {name:?}"))),
        }
    }
    if entries.is_empty() {
        return Ok(None);
    }
    store(&entries.into_values().collect::<Vec<_>>(), out).map(Some)
}

fn entry(name: &str, mode: FileMode, id: ObjectId) -> TreeEntry {
    TreeEntry {
        name: name.to_owned(),
        mode,
        id,
    }
}

fn store(entries: &[TreeEntry], out: &mut Vec<(ObjectId, Vec<u8>)>) -> Result<ObjectId> {
    let bytes = encode_tree(entries)?;
    let id = hash_object(ObjectKind::Tree, &bytes);
    if !out.iter().any(|(existing, _)| *existing == id) {
        out.push((id, bytes));
    }
    Ok(id)
}
