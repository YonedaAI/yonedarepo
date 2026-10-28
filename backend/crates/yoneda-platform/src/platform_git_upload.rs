//! The sending side of a stock `git fetch`/`clone` over HTTPS, as Worker compute. The
//! authority names the commits to send (`repo_git_walk`); each is diffed against its first
//! parent (which the client has, or receives too), so only the trees and files a commit
//! introduced are sent, the whole tree only for a root. Trees the walk reads are kept and
//! re-encoded for the pack; blobs and commits come from the adapter, checked against their
//! ids. The pack is undeltified and written entry by entry, so it streams out. A partial
//! clone (`omit_blobs`) sends commits and trees only, plus any blobs wanted by id
//! (`objects`), which is how Git fetches a missing blob later. Wanted annotated tag objects
//! come with the walk (`tags`, from the authority) and are written from this session.
use crate::platform_objects::{new_trees, supplied_tree};
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
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

fn within_limit(objects: usize) -> Result<()> {
    if objects > MAX_OBJECTS {
        return Err(Error::new(
            "TOO_LARGE",
            format!("A fetch over HTTPS sends at most {MAX_OBJECTS} objects"),
        ));
    }
    Ok(())
}

struct Sent {
    commit: ObjectId,
    tree: ObjectId,
    base: Option<ObjectId>,
}

#[derive(Default)]
pub struct UploadSession {
    commits: Vec<Sent>,
    omit_blobs: bool,
    wanted_blobs: Vec<ObjectId>,
    /// Annotated tag objects to send, checked against their ids.
    tags: Vec<(ObjectId, Vec<u8>)>,
    trees: HashMap<ObjectId, Vec<TreeEntry>>,
    objects: Vec<(ObjectId, ObjectKind)>,
    writer: Option<PackWriter>,
}

impl UploadSession {
    /// `walk` is `repo_git_walk`'s answer: the commits to send, each with its tree and its
    /// first parent's tree, the blobs wanted by id (`objects`) and the annotated tag objects
    /// wanted (`tags: [{id, data_b64}]`); with `omit_blobs`, no other blob is sent.
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
        let wanted_blobs = walk["objects"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|id| ObjectId::parse(id.as_str().unwrap_or_default()))
            .collect::<Result<_>>()?;
        let mut tags = Vec::new();
        for tag in walk["tags"].as_array().into_iter().flatten() {
            let id = ObjectId::parse(&string(tag, "id")?)?;
            let data = STANDARD
                .decode(tag["data_b64"].as_str().unwrap_or_default())
                .map_err(|_| bad("tags[].data_b64 must be base64"))?;
            if hash_object(ObjectKind::Tag, &data) != id {
                return Err(Error::new(
                    "GIT_OBJECT_INVALID",
                    format!("Stored tag does not hash to {id}"),
                ));
            }
            tags.push((id, data));
        }
        Ok(Self {
            commits,
            omit_blobs: walk["omit_blobs"] == true,
            wanted_blobs,
            tags,
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
                    for tree in new_trees(sent.tree, &changes, &self.trees) {
                        add(tree, ObjectKind::Tree, &mut objects);
                    }
                    for change in changes.iter().filter(|_| !self.omit_blobs) {
                        if let Some((mode, id)) = change.new
                            && mode != FileMode::Gitlink
                        {
                            add(id, ObjectKind::Blob, &mut objects);
                        }
                    }
                }
            }
            within_limit(objects.len())?;
        }
        if !need.is_empty() {
            return Ok(json!({ "need_trees": need }));
        }
        for id in &self.wanted_blobs {
            add(*id, ObjectKind::Blob, &mut objects);
        }
        for (id, _) in &self.tags {
            add(*id, ObjectKind::Tag, &mut objects);
        }
        within_limit(objects.len())?;
        let fetch: Vec<Value> = objects
            .iter()
            .filter(|(_, kind)| matches!(kind, ObjectKind::Commit | ObjectKind::Blob))
            .map(|(id, kind)| json!({ "id": id, "kind": kind.name() }))
            .collect();
        let trees: Vec<ObjectId> = objects
            .iter()
            .filter(|(_, kind)| *kind == ObjectKind::Tree)
            .map(|(id, _)| *id)
            .collect();
        let tags: Vec<ObjectId> = self.tags.iter().map(|(id, _)| *id).collect();
        self.objects = objects;
        Ok(json!({ "count": self.objects.len(), "fetch": fetch, "trees": trees, "tags": tags }))
    }

    /// The pack header (after a final `step`).
    pub fn pack_start(&mut self) -> Result<Vec<u8>> {
        let count = u32::try_from(self.objects.len()).map_err(|_| bad("Too many objects"))?;
        let (writer, header) = PackWriter::new(count);
        self.writer = Some(writer);
        Ok(header)
    }

    /// One pack entry: a tree this session read or a tag object the walk carried (no
    /// `data`), or a blob or commit the adapter read, which must hash to `id`.
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
            ("tag", None) => {
                let (_, data) = self
                    .tags
                    .iter()
                    .find(|(tag, _)| *tag == id)
                    .ok_or_else(|| bad(&format!("Tag {id} is not in this fetch")))?;
                (ObjectKind::Tag, data.clone())
            }
            ("blob", Some(data)) => (ObjectKind::Blob, data.to_vec()),
            ("commit", Some(data)) => (ObjectKind::Commit, data.to_vec()),
            _ => {
                return Err(bad(
                    "A pack entry is a tree or tag, or a blob or commit with data",
                ));
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_fetch_sends_trees_and_only_the_blobs_wanted_by_id() {
        let kept = hash_object(ObjectKind::Blob, b"kept\n");
        let other = hash_object(ObjectKind::Blob, b"other\n");
        let entries = vec![
            TreeEntry {
                name: "a.txt".into(),
                mode: FileMode::Blob,
                id: kept,
            },
            TreeEntry {
                name: "b.txt".into(),
                mode: FileMode::Blob,
                id: other,
            },
        ];
        let data = encode_tree(&entries).unwrap();
        let tree = hash_object(ObjectKind::Tree, &data);
        let commit = "c".repeat(40);
        let walk = |omit: bool, objects: Value| {
            json!({ "commits": [{ "commit": commit, "tree": tree, "base_tree": null }],
                    "omit_blobs": omit, "objects": objects })
        };
        let trees = json!({ "trees": [{ "id": tree, "data_b64": STANDARD.encode(&data) }] });
        let listed = |walk: Value| {
            let mut session = UploadSession::new(&walk).unwrap();
            assert_eq!(
                session.step(&json!({})).unwrap()["need_trees"],
                json!([tree])
            );
            session.step(&trees).unwrap()
        };
        let full = listed(walk(false, json!([])));
        assert_eq!(full["count"], 4);
        assert_eq!(full["trees"], json!([tree]));
        let partial = listed(walk(true, json!([])));
        assert_eq!(partial["count"], 2);
        assert_eq!(
            partial["fetch"],
            json!([{ "id": commit, "kind": "commit" }])
        );
        // A promisor fetch: the blob by id, no commit.
        let mut lazy = UploadSession::new(&json!({ "commits": [], "omit_blobs": true,
                                                   "objects": [kept] }))
        .unwrap();
        let only = lazy.step(&json!({})).unwrap();
        assert_eq!(only["fetch"], json!([{ "id": kept, "kind": "blob" }]));
        assert_eq!(only["count"], 1);
    }

    #[test]
    fn sends_wanted_tag_objects_from_the_walk() {
        let data = format!("object {}\ntype commit\ntag v1\n\nm\n", "c".repeat(40));
        let id = hash_object(ObjectKind::Tag, data.as_bytes());
        let tag = json!({ "id": id, "data_b64": STANDARD.encode(&data) });
        let mut session = UploadSession::new(&json!({ "commits": [], "tags": [tag] })).unwrap();
        let listed = session.step(&json!({})).unwrap();
        assert_eq!(
            (&listed["count"], &listed["tags"], &listed["fetch"]),
            (&json!(1), &json!([id]), &json!([]))
        );
        session.pack_start().unwrap();
        assert!(session.pack_entry("tag", &id.hex(), None).is_ok());
        let wrong = json!({ "id": "d".repeat(40), "data_b64": STANDARD.encode(&data) });
        assert!(UploadSession::new(&json!({ "commits": [], "tags": [wrong] })).is_err());
    }
}
