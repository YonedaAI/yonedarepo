//! Building a commit from its parent, the changed paths and the trees along them: pure
//! computation with no store, shared by the authority's prepare and stateless compute.
use super::changes::{Change, Content};
use crate::platform_objects;
use crate::storage::{bad, string};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use yoneda_core::{
    Error, Result,
    git_object::*,
    txlog::{PathOp, PathTouch},
};

const COMMITTER: (&str, &str) = ("YonedaRepo", "commits@yonedarepo.invalid");

/// What a commit needs to know about a parent.
pub(crate) struct Parent {
    pub id: ObjectId,
    pub tree: ObjectId,
    pub generation: u64,
}

pub(crate) struct Built {
    pub id: ObjectId,
    pub root: ObjectId,
    pub parents: Vec<ObjectId>,
    pub generation: u64,
    pub touches: Vec<PathTouch>,
    pub read_set: Vec<String>,
    pub message: String,
    /// Every new object: the commit, then trees, then blobs.
    pub objects: Vec<(ObjectId, ObjectKind, Vec<u8>)>,
    /// The new trees alone (encoded), for a tree cache.
    pub trees: Vec<(ObjectId, Vec<u8>)>,
}

impl Built {
    pub fn object_refs(&self) -> Vec<(ObjectId, ObjectKind, &[u8])> {
        self.objects
            .iter()
            .map(|(i, k, d)| (*i, *k, d.as_slice()))
            .collect()
    }
}

pub(crate) struct Trees(pub HashMap<ObjectId, Vec<TreeEntry>>);
impl TreeSource for Trees {
    fn tree(&self, id: &ObjectId) -> Result<Vec<TreeEntry>> {
        self.0
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("TREE_MISSING", format!("Tree {id} was not supplied")))
    }
}

/// Supplied trees are untrusted: each must hash to the id it is filed under.
pub(crate) fn supplied_trees(c: &Value) -> Result<Trees> {
    platform_objects::supplied_trees(c).map(Trees)
}

/// Directories on changed paths that are not yet supplied (the next walk frontier).
pub(crate) fn frontier(
    root: Option<ObjectId>,
    paths: &[&str],
    trees: &Trees,
) -> BTreeSet<ObjectId> {
    let mut missing = BTreeSet::new();
    // A merge commit may change nothing (every path conflicted); it still rewrites the root.
    if paths.is_empty()
        && let Some(id) = root
        && !trees.0.contains_key(&id)
    {
        missing.insert(id);
    }
    for path in paths {
        let parts: Vec<&str> = path.split('/').collect();
        let mut dir = root;
        for (depth, part) in parts.iter().enumerate() {
            let Some(id) = dir else { break };
            let Some(entries) = trees.0.get(&id) else {
                missing.insert(id);
                break;
            };
            if depth + 1 == parts.len() {
                break;
            }
            dir = entries
                .iter()
                .find(|e| e.name == *part && e.mode.is_tree())
                .map(|e| e.id);
        }
    }
    missing
}

pub(crate) fn existing(root: Option<ObjectId>, path: &str, trees: &Trees) -> Option<TreeEntry> {
    let mut dir = root?;
    let parts: Vec<&str> = path.split('/').collect();
    for (depth, part) in parts.iter().enumerate() {
        let entry = trees.0.get(&dir)?.iter().find(|e| e.name == *part)?.clone();
        if depth + 1 == parts.len() {
            return Some(entry);
        }
        dir = entry.id;
    }
    None
}

/// Builds the commit `c` describes (`message`, `author`, `read_set`) on `parent` (plus
/// merged parents), applying `changes` through `trees`. `known` vouches for blobs referenced
/// by id instead of sent.
pub(crate) fn build(
    c: &Value,
    parent: Option<&Parent>,
    merges: &[Parent],
    changes: &[Change],
    trees: &Trees,
    now: i64,
    known: &dyn Fn(&ObjectId) -> Result<()>,
) -> Result<Built> {
    let root = parent.map(|p| p.tree);
    let message = string(c, "message")?;
    let author = Signature {
        name: string(&c["author"], "name")?,
        email: string(&c["author"], "email")?,
        seconds: now / 1000,
        offset: "+0000".into(),
    };
    let committer = Signature {
        name: COMMITTER.0.into(),
        email: COMMITTER.1.into(),
        ..author.clone()
    };
    let read_set: Vec<String> =
        serde_json::from_value(c.get("read_set").cloned().unwrap_or(json!([])))
            .map_err(|_| bad("read_set must be a list of paths or path#symbol entries"))?;
    if read_set.len() > 1000
        || read_set
            .iter()
            .any(|p| p.is_empty() || p.starts_with('/') || p.contains(".."))
    {
        return Err(bad(
            "read_set entries must be relative paths, dir/ prefixes or path#symbol",
        ));
    }

    let mut blobs: Vec<(ObjectId, &[u8])> = Vec::new();
    let mut path_changes = Vec::new();
    let mut touches = Vec::new();
    let mut conflicts = Vec::new();
    for change in changes {
        let old = existing(root, &change.path, trees).filter(|e| !e.mode.is_tree());
        if let Some(expected) = change.expect
            && old.as_ref().map(|o| o.id) != expected
        {
            conflicts.push(change.path.clone());
            continue;
        }
        let new = match &change.target {
            None => None,
            Some((m, Content::Bytes(data))) => Some((*m, hash_object(ObjectKind::Blob, data))),
            Some((m, Content::Known(id))) => {
                known(id)?;
                Some((*m, *id))
            }
        };
        if matches!((&old, new), (Some(o), Some((m, id))) if o.mode == m && o.id == id) {
            continue;
        }
        if let Some((_, Content::Bytes(data))) = &change.target
            && let Some((_, id)) = new
            && !blobs.iter().any(|(b, _)| *b == id)
        {
            blobs.push((id, data));
        }
        let op = match (&old, new) {
            (None, Some(_)) => PathOp::Add,
            (Some(_), Some(_)) => PathOp::Modify,
            (Some(_), None) => PathOp::Delete,
            (None, None) => {
                return Err(Error::new(
                    "NOT_FOUND",
                    format!("Cannot delete missing {}", change.path),
                ));
            }
        };
        touches.push(PathTouch {
            path: change.path.clone(),
            op,
            old_blob: old.map(|o| o.id),
            new_blob: new.map(|n| n.1),
            mode: new.map(|(m, _)| crate::platform_objects::entry_type(m).to_owned()),
        });
        path_changes.push(PathChange {
            path: change.path.clone(),
            target: new,
        });
    }
    if !conflicts.is_empty() {
        return Err(Error::new(
            "CONFLICT",
            format!(
                "The parent changed on {}; these paths need a three-way merge",
                conflicts.join(", ")
            ),
        ));
    }
    if touches.is_empty() && merges.is_empty() {
        return Err(Error::new(
            "NO_CHANGES",
            "Every change matches the parent commit",
        ));
    }
    let rewrite = rewrite_tree(root, &path_changes, trees)?;
    // A merge commit's second parent is the merged work; its tree is `changes` applied to
    // the first parent, so the commit's changeset stays relative to the first parent.
    if !merges.is_empty() && parent.is_none() {
        return Err(bad("A merge needs a first parent"));
    }
    if merges.len() > 128 {
        return Err(bad("A merge has at most 128 merged parents"));
    }
    let parents: Vec<ObjectId> = parent.into_iter().chain(merges).map(|p| p.id).collect();
    let commit = Commit::new(rewrite.root, &parents, &author, &committer, &message)?;
    let commit_bytes = commit.encode();
    let id = commit.id();

    let mut objects: Vec<(ObjectId, ObjectKind, Vec<u8>)> =
        vec![(id, ObjectKind::Commit, commit_bytes)];
    objects.extend(
        rewrite
            .trees
            .iter()
            .map(|(t, bytes)| (*t, ObjectKind::Tree, bytes.clone())),
    );
    objects.extend(
        blobs
            .iter()
            .map(|(b, data)| (*b, ObjectKind::Blob, data.to_vec())),
    );
    let generation = parent
        .into_iter()
        .chain(merges)
        .map(|p| p.generation + 1)
        .max()
        .unwrap_or(1);
    Ok(Built {
        id,
        root: rewrite.root,
        parents,
        generation,
        touches,
        read_set,
        message,
        objects,
        trees: rewrite.trees,
    })
}

/// Structured copies of new objects for adapters' cache tiers (no Git parsing there).
pub(crate) fn objects_json(built: &Built) -> Result<Value> {
    Ok(json!(
        built
            .objects
            .iter()
            .map(|(oid, kind, data)| platform_objects::object_json(*oid, *kind, data))
            .collect::<Result<Vec<_>>>()?
    ))
}
