//! The sending side of a stock `git fetch`/`clone` over HTTPS, as Worker compute. The
//! authority names the commits to send (`repo_git_walk`); each is diffed against its first
//! parent (which the client has, or receives too), so only the trees and files a commit
//! introduced are sent, the whole tree only for a root. Trees the walk reads are kept and
//! re-encoded for the pack; blobs and commits come from the adapter, checked against their
//! ids. The pack is undeltified and written entry by entry, so it streams out.
use crate::platform_objects::supplied_tree;
use crate::storage::{bad, string};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::{
        FileMode, ObjectId, ObjectKind, PackWriter, TreeEntry, Walk, diff_trees, encode_tree,
        hash_object,
    },
};

/// Files one sent commit may introduce (a root lists every file).
const MAX_FILES: usize = 200_000;
/// Objects one fetch sends: each costs the adapter a read.
pub const MAX_OBJECTS: usize = 40_000;

struct Sent {
    commit: ObjectId,
    tree: ObjectId,
    base: Option<ObjectId>,
}

#[derive(Default)]
pub struct UploadSession {
    commits: Vec<Sent>,
    trees: HashMap<ObjectId, Vec<TreeEntry>>,
    objects: Vec<(ObjectId, ObjectKind)>,
    writer: Option<PackWriter>,
}

impl UploadSession {
    /// `walk` is `repo_git_walk`'s answer: the commits to send, each with its tree and its
    /// first parent's tree.
    pub fn new(walk: &Value) -> Result<Self> {
        let mut commits = Vec::new();
        for c in walk["commits"].as_array().into_iter().flatten() {
            commits.push(Sent {
                commit: ObjectId::parse(&string(c, "commit")?)?,
                tree: ObjectId::parse(&string(c, "tree")?)?,
                base: match c["base_tree"].as_str() {
                    Some(id) => Some(ObjectId::parse(id)?),
                    None => None,
                },
            });
        }
        Ok(Self {
            commits,
            ..Self::default()
        })
    }

    /// Adds the trees the adapter read (raw `data_b64` or `entries`, checked against their
    /// ids) and enumerates again: `{need_trees}`, or the objects to send with the blobs and
    /// commits the adapter must supply.
    pub fn step(&mut self, input: &Value) -> Result<Value> {
        for tree in input["trees"].as_array().into_iter().flatten() {
            let id = ObjectId::parse(&string(tree, "id")?)?;
            let entries = supplied_tree(&id, tree)?;
            self.trees.insert(id, entries);
        }
        let mut need = BTreeSet::new();
        let mut objects = Vec::new();
        let mut seen = HashSet::new();
        let mut add = |id: ObjectId, kind: ObjectKind, objects: &mut Vec<_>| {
            if seen.insert(id) {
                objects.push((id, kind));
            }
        };
        for sent in &self.commits {
            add(sent.commit, ObjectKind::Commit, &mut objects);
            match diff_trees(sent.base, Some(sent.tree), &self.trees, MAX_FILES)? {
                Walk::Need(ids) => need.extend(ids),
                Walk::Done(changes) => {
                    if sent.base != Some(sent.tree) {
                        add(sent.tree, ObjectKind::Tree, &mut objects);
                    }
                    for change in &changes {
                        let mut at = sent.tree;
                        let parts: Vec<&str> = change.path.split('/').collect();
                        for dir in &parts[..parts.len() - 1] {
                            let Some(entry) = self.trees.get(&at).and_then(|entries| {
                                entries.iter().find(|e| e.name == *dir && e.mode.is_tree())
                            }) else {
                                break;
                            };
                            at = entry.id;
                            add(at, ObjectKind::Tree, &mut objects);
                        }
                        if let Some((mode, id)) = change.new
                            && mode != FileMode::Gitlink
                        {
                            add(id, ObjectKind::Blob, &mut objects);
                        }
                    }
                }
            }
            if objects.len() > MAX_OBJECTS {
                return Err(Error::new(
                    "TOO_LARGE",
                    format!("A fetch over HTTPS sends at most {MAX_OBJECTS} objects"),
                ));
            }
        }
        if !need.is_empty() {
            return Ok(json!({ "need_trees": need }));
        }
        let fetch: Vec<Value> = objects
            .iter()
            .filter(|(_, kind)| *kind != ObjectKind::Tree)
            .map(|(id, kind)| json!({ "id": id, "kind": kind.name() }))
            .collect();
        let trees: Vec<ObjectId> = objects
            .iter()
            .filter(|(_, kind)| *kind == ObjectKind::Tree)
            .map(|(id, _)| *id)
            .collect();
        self.objects = objects;
        Ok(json!({ "count": self.objects.len(), "fetch": fetch, "trees": trees }))
    }

    /// The pack header (after a final `step`).
    pub fn pack_start(&mut self) -> Result<Vec<u8>> {
        let count = u32::try_from(self.objects.len()).map_err(|_| bad("Too many objects"))?;
        let (writer, header) = PackWriter::new(count);
        self.writer = Some(writer);
        Ok(header)
    }

    /// One pack entry: a tree from those this session read (no `data`), or a blob or
    /// commit the adapter read, which must hash to `id`.
    pub fn pack_entry(&mut self, kind: &str, id: &str, data: Option<&[u8]>) -> Result<Vec<u8>> {
        let id = ObjectId::parse(id)?;
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| bad("The pack has not started"))?;
        let (kind, bytes) = match (kind, data) {
            ("tree", None) => {
                let entries = self
                    .trees
                    .get(&id)
                    .ok_or_else(|| bad(&format!("Tree {id} was never read")))?;
                (ObjectKind::Tree, encode_tree(entries)?)
            }
            ("blob", Some(data)) => (ObjectKind::Blob, data.to_vec()),
            ("commit", Some(data)) => (ObjectKind::Commit, data.to_vec()),
            _ => return Err(bad("A pack entry is a tree, or a blob or commit with data")),
        };
        if hash_object(kind, &bytes) != id {
            return Err(Error::new(
                "GIT_OBJECT_INVALID",
                format!("Stored {} does not hash to {id}", kind.name()),
            ));
        }
        Ok(writer.entry(kind, &bytes))
    }

    /// The pack trailer; the session is spent.
    pub fn pack_finish(&mut self) -> Result<Vec<u8>> {
        let writer = self
            .writer
            .take()
            .ok_or_else(|| bad("The pack has not started"))?;
        Ok(writer.finish().to_vec())
    }
}
