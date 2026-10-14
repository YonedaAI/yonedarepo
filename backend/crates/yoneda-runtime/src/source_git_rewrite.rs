//! Rewrite only affected ancestor trees, retaining untouched subtree and blob identities.
use crate::{
    source_git::SourceGitObjects,
    source_git_tree::{TreeEntry, encode_tree, validate_oid},
};
use std::{collections::BTreeMap, io};
#[derive(Clone, Debug)]
pub(crate) enum TreeEdit {
    Set { mode: u32, oid: String },
    Delete,
}
pub(crate) fn rewrite_tree(
    store: &mut SourceGitObjects,
    base: &str,
    edits: &BTreeMap<String, TreeEdit>,
    load: &mut impl FnMut(&str, &str) -> io::Result<Vec<TreeEntry>>,
) -> io::Result<String> {
    validate_oid(base)?;
    for (path, edit) in edits {
        yoneda_core::validate_path(path).map_err(io::Error::other)?;
        if let TreeEdit::Set { mode, oid } = edit {
            validate_oid(oid)?;
            if ![0o100644, 0o100755].contains(mode) {
                return Err(io::Error::other("Source edit is not a regular file"));
            }
        }
    }
    if edits.is_empty() {
        return Ok(base.into());
    }
    rewrite_directory(store, "", Some(base), edits, load)?
        .ok_or_else(|| io::Error::other("Capture root missing"))
}

fn rewrite_directory(
    store: &mut SourceGitObjects,
    path: &str,
    base: Option<&str>,
    edits: &BTreeMap<String, TreeEdit>,
    load: &mut impl FnMut(&str, &str) -> io::Result<Vec<TreeEntry>>,
) -> io::Result<Option<String>> {
    let initial = if let Some(oid) = base {
        let entries = load(path, oid)?;
        if store.hash("tree", &encode_tree(&entries)?)? != oid {
            return Err(io::Error::other(
                "Ancestor tree metadata hash differs from frozen base",
            ));
        }
        entries
    } else {
        vec![]
    };
    let mut entries = initial
        .into_iter()
        .map(|e| (e.name.clone(), e))
        .collect::<BTreeMap<_, _>>();
    let mut groups: BTreeMap<String, (Option<TreeEdit>, BTreeMap<String, TreeEdit>)> =
        BTreeMap::new();
    for (relative, edit) in edits {
        let (name, child) = relative
            .split_once('/')
            .map_or((relative.as_str(), None), |(n, c)| (n, Some(c)));
        let group = groups.entry(name.into()).or_default();
        if let Some(child) = child {
            group.1.insert(child.into(), edit.clone());
        } else {
            group.0 = Some(edit.clone());
        }
    }
    for (name, (direct, children)) in groups {
        let previous = entries.get(&name).cloned();
        let child_path = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        let old_tree = previous
            .as_ref()
            .filter(|e| e.mode == 0o040000)
            .map(|e| e.oid.as_str());
        match direct {
            Some(TreeEdit::Set { mode, oid }) => {
                if previous.as_ref().is_some_and(|e| e.mode == 0o040000) {
                    if rewrite_directory(store, &child_path, old_tree, &children, load)?.is_some() {
                        return Err(io::Error::other(
                            "Cannot replace directory without explicit deletion of every file",
                        ));
                    }
                } else if !children.is_empty() {
                    return Err(io::Error::other(
                        "File edit conflicts with descendant edits",
                    ));
                }
                entries.insert(name.clone(), TreeEntry { name, mode, oid });
            }
            Some(TreeEdit::Delete) => {
                if previous.is_none() || old_tree.is_some() {
                    return Err(io::Error::other("Delete is not an explicit existing file"));
                }
                entries.remove(&name);
                if !children.is_empty()
                    && let Some(oid) = rewrite_directory(store, &child_path, None, &children, load)?
                {
                    entries.insert(
                        name.clone(),
                        TreeEntry {
                            name,
                            mode: 0o040000,
                            oid,
                        },
                    );
                }
            }
            None => {
                if previous.is_some() && old_tree.is_none() {
                    return Err(io::Error::other(
                        "Cannot implicitly replace existing file with directory",
                    ));
                }
                if let Some(oid) = rewrite_directory(store, &child_path, old_tree, &children, load)?
                {
                    entries.insert(
                        name.clone(),
                        TreeEntry {
                            name,
                            mode: 0o040000,
                            oid,
                        },
                    );
                } else {
                    entries.remove(&name);
                }
            }
        }
    }
    if entries.is_empty() && !path.is_empty() {
        return Ok(None);
    }
    let raw = encode_tree(&entries.into_values().collect::<Vec<_>>())?;
    let oid = store.hash("tree", &raw)?;
    if base != Some(oid.as_str()) {
        store.write("tree", &raw)?;
    }
    Ok(Some(oid))
}
