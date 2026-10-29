//! The sending side of a stock `git fetch`/`clone` over HTTPS, as Worker compute. The
//! authority names the commits to send (`repo_git_walk`); each is diffed against its first
//! parent (which the client has, or receives too), so only the trees and files a commit
//! introduced are sent, the whole tree only for a root. Trees the walk reads are kept and
//! re-encoded for the pack; blobs and commits come from the adapter, checked against their
//! ids. The pack is undeltified and written entry by entry, so it streams out. A partial
//! clone (`omit_blobs`) sends commits and trees only, plus any blobs wanted by id
//! (`objects`), which is how Git fetches a missing blob later. Wanted annotated tag objects
//! come with the walk (`tags`, from the authority) and are written from this session.
//!
//! Commits go in waves of WAVE_COMMITS, so memory is bounded by a wave's trees, not the
//! history: `step` walks every wave once to count what the pack holds (its header comes
//! first), keeping only the ids seen; `send` walks them again and lists each wave's
//! objects to write. Trees are kept between waves (and passes) while they fit TREE_BYTES,
//! so a fetch of a modest history reads each tree once.
use crate::platform_objects::{new_trees, supplied_tree};
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::{
        FileMode, ObjectHasher, ObjectId, ObjectKind, PackWriter, TreeEntry, Walk, diff_trees,
        encode_delta, encode_tree, hash_object,
    },
};

mod large;

/// Files one sent commit may introduce (a root lists every file).
const MAX_FILES: usize = 200_000;
/// Commits walked together.
const WAVE_COMMITS: usize = 256;
/// Tree entries' bytes (about) kept between waves; past it, each wave reads its own.
const TREE_BYTES: usize = 32 * 1024 * 1024;
/// Rounds of tree reads one wave may take (a directory level each).
const WAVE_ROUNDS: usize = 64;
/// Delta chains are at most this long (Git's default `pack.depth`).
const MAX_DEPTH: u8 = 50;
/// File versions larger than this are sent whole and never kept as a base.
const MAX_DELTA_BYTES: usize = 4 * 1024 * 1024;
/// Bytes of written versions kept as bases for versions still to come.
const BASE_BYTES: usize = 32 * 1024 * 1024;

/// One wave's walk: the trees it still needs, or its objects in order with the file
/// version pairs its diffs found.
enum WaveWalk {
    Need(BTreeSet<ObjectId>),
    Done(Vec<(ObjectId, ObjectKind)>, Vec<(ObjectId, ObjectId)>),
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
    /// About how many bytes `trees` holds, and whether trees are still kept between waves.
    tree_bytes: usize,
    dropping: bool,
    /// The wave walked next, the rounds it took so far, and the pass (counting, sending).
    wave: usize,
    rounds: usize,
    sending: bool,
    /// Objects counted and not yet listed to send; how many the pack holds.
    unsent: HashSet<ObjectId>,
    count: usize,
    writer: Option<PackWriter>,
    /// Each file version's other versions in this pack (its path's previous and next, from
    /// the commits' diffs): one written first is the base the other is sent against.
    partners: HashMap<ObjectId, Vec<ObjectId>>,
    /// Written versions kept as bases while a partner is still to come, with their chain
    /// depth; `base_bytes` in all.
    bases: HashMap<ObjectId, (Vec<u8>, u8)>,
    base_bytes: usize,
    written: HashSet<ObjectId>,
    /// A file streamed through the adapter (`large_start`): its id and its content's hash.
    large: Option<(ObjectId, ObjectHasher)>,
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
    /// ids).
    fn add_trees(&mut self, input: &Value) -> Result<()> {
        for tree in input["trees"].as_array().into_iter().flatten() {
            let id = ObjectId::parse(&string(tree, "id")?)?;
            let entries = supplied_tree(&id, tree)?;
            self.tree_bytes += 32 + entries.iter().map(|e| e.name.len() + 32).sum::<usize>();
            self.trees.insert(id, entries);
        }
        Ok(())
    }

    /// Walks wave `wave` with the trees held: what it still needs, or its objects.
    fn walk_wave(&self, wave: usize) -> Result<WaveWalk> {
        let mut need = BTreeSet::new();
        let mut objects = Vec::new();
        let mut pairs = Vec::new();
        let mut seen = HashSet::new();
        let mut add = |id: ObjectId, kind: ObjectKind, objects: &mut Vec<_>| {
            if seen.insert(id) {
                objects.push((id, kind));
            }
        };
        let end = self.commits.len().min((wave + 1) * WAVE_COMMITS);
        for sent in &self.commits[wave * WAVE_COMMITS..end] {
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
                            if let Some((old_mode, old)) = change.old
                                && old_mode != FileMode::Gitlink
                            {
                                pairs.push((old, id));
                            }
                        }
                    }
                }
            }
        }
        Ok(if need.is_empty() {
            WaveWalk::Done(objects, pairs)
        } else {
            WaveWalk::Need(need)
        })
    }

    fn waves(&self) -> usize {
        self.commits.len().div_ceil(WAVE_COMMITS)
    }

    /// The trees one more round of the current wave needs, failing past WAVE_ROUNDS.
    fn need(&mut self, need: BTreeSet<ObjectId>) -> Result<Value> {
        self.rounds += 1;
        if self.rounds > WAVE_ROUNDS {
            return Err(bad("Directories are nested too deeply"));
        }
        Ok(json!({ "need_trees": need }))
    }

    /// Moves to the next wave, letting go of its trees once they no longer fit.
    fn next_wave(&mut self) {
        self.wave += 1;
        self.rounds = 0;
        self.dropping |= self.tree_bytes > TREE_BYTES;
        if self.dropping {
            self.trees.clear();
            self.tree_bytes = 0;
        }
    }

    /// The counting pass: adds the trees the adapter read and walks on, wave by wave:
    /// `{need_trees}`, or once every wave is walked `{count}`, what the pack holds.
    pub fn step(&mut self, input: &Value) -> Result<Value> {
        if self.sending {
            return Err(bad("The fetch is already sending"));
        }
        self.add_trees(input)?;
        while self.wave < self.waves() {
            match self.walk_wave(self.wave)? {
                WaveWalk::Need(need) => return self.need(need),
                WaveWalk::Done(objects, _) => {
                    self.unsent.extend(objects.into_iter().map(|(id, _)| id));
                    self.next_wave();
                }
            }
        }
        self.unsent.extend(self.wanted_blobs.iter().copied());
        self.count = self.unsent.len() + self.tags.len();
        Ok(json!({ "count": self.count, "waves": self.waves() }))
    }

    /// Which of `ids` (a list) the counted pack holds: after `step` answered `{count}`,
    /// so a fetch refuses one carrying a withheld blob before its pack starts.
    pub fn holds(&self, ids: &Value) -> Result<Value> {
        let mut held = Vec::new();
        for id in ids.as_array().ok_or_else(|| bad("ids must be a list"))? {
            let id = ObjectId::parse(id.as_str().unwrap_or_default())?;
            if self.unsent.contains(&id) {
                held.push(id);
            }
        }
        Ok(json!(held))
    }

    /// The sending pass (after `step` answered `{count}`): adds the trees the adapter read
    /// and walks the next wave: `{need_trees}`, or its objects not listed before (`trees`
    /// to write from here, `fetch` for the adapter to read); last the blobs wanted by id
    /// and the tag objects, with `done`.
    pub fn send(&mut self, input: &Value) -> Result<Value> {
        if !self.sending {
            self.sending = true;
            self.wave = 0;
            self.rounds = 0;
        } else if self.rounds == 0 && self.dropping {
            // The last wave is written: its trees go unless they all fit.
            self.trees.clear();
            self.tree_bytes = 0;
        }
        self.add_trees(input)?;
        if self.wave >= self.waves() {
            let fetch: Vec<Value> = self
                .wanted_blobs
                .iter()
                .filter(|id| self.unsent.remove(*id))
                .map(|id| json!({ "id": id, "kind": "blob" }))
                .collect();
            let tags: Vec<ObjectId> = self.tags.iter().map(|(id, _)| *id).collect();
            return Ok(json!({ "trees": [], "fetch": fetch, "tags": tags, "done": true }));
        }
        let (objects, pairs) = match self.walk_wave(self.wave)? {
            WaveWalk::Need(need) => return self.need(need),
            WaveWalk::Done(objects, pairs) => (objects, pairs),
        };
        let objects: Vec<(ObjectId, ObjectKind)> = objects
            .into_iter()
            .filter(|(id, _)| self.unsent.remove(id))
            .collect();
        // Only versions both sent in this wave pair up (no thin packs).
        let listed: HashSet<ObjectId> = objects.iter().map(|(id, _)| *id).collect();
        self.partners.clear();
        self.bases.clear();
        self.base_bytes = 0;
        for (old, new) in pairs {
            if old != new && listed.contains(&old) && listed.contains(&new) {
                self.partners.entry(old).or_default().push(new);
                self.partners.entry(new).or_default().push(old);
            }
        }
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
        // The adapter writes this wave's trees before asking for the next.
        self.wave += 1;
        self.rounds = 0;
        Ok(json!({ "trees": trees, "fetch": fetch, "done": false }))
    }

    /// The pack header (after a final `step`).
    pub fn pack_start(&mut self) -> Result<Vec<u8>> {
        let count = u32::try_from(self.count).map_err(|_| bad("Too many objects"))?;
        let (writer, header) = PackWriter::new(count);
        self.writer = Some(writer);
        Ok(header)
    }

    /// One pack entry: a tree this session read or a tag object the walk carried (no
    /// `data`), or a blob or commit the adapter read, which must hash to `id`.
    pub fn pack_entry(&mut self, kind: &str, id: &str, data: Option<&[u8]>) -> Result<Vec<u8>> {
        let id = ObjectId::parse(id)?;
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
            ("blob", Some(data)) => {
                if hash_object(ObjectKind::Blob, data) != id {
                    return Err(Error::new(
                        "GIT_OBJECT_INVALID",
                        format!("Stored blob does not hash to {id}"),
                    ));
                }
                return self.blob_entry(id, data);
            }
            ("commit", Some(data)) => (ObjectKind::Commit, data.to_vec()),
            _ => {
                return Err(bad(
                    "A pack entry is a tree or tag, or a blob or commit with data",
                ));
            }
        };
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| bad("The pack has not started"))?;
        if hash_object(kind, &bytes) != id {
            return Err(Error::new(
                "GIT_OBJECT_INVALID",
                format!("Stored {} does not hash to {id}", kind.name()),
            ));
        }
        Ok(writer.entry(kind, &bytes))
    }

    /// A file version: as a delta against a partner already written and kept, when that
    /// is under half its size and the chain stays within `MAX_DEPTH`, else whole. It is
    /// then kept as a base while a partner is still to come, and a base whose partners are
    /// all written is let go.
    fn blob_entry(&mut self, id: ObjectId, data: &[u8]) -> Result<Vec<u8>> {
        let partners = self.partners.get(&id).cloned().unwrap_or_default();
        let base = partners
            .iter()
            .filter_map(|p| self.bases.get(p).map(|(bytes, depth)| (p, bytes, *depth)))
            .filter(|(_, _, depth)| *depth < MAX_DEPTH)
            .min_by_key(|(_, _, depth)| *depth);
        let delta = base
            .filter(|_| data.len() <= MAX_DELTA_BYTES)
            .and_then(|(p, bytes, depth)| {
                encode_delta(bytes, data, data.len() / 2).map(|delta| (*p, delta, depth + 1))
            });
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| bad("The pack has not started"))?;
        let (entry, depth) = match delta {
            Some((base, delta, depth)) => (writer.delta_entry(&base, &delta), depth),
            None => (writer.entry(ObjectKind::Blob, data), 0),
        };
        self.wrote(id, &partners);
        let awaited = partners.iter().any(|p| !self.written.contains(p));
        if awaited && data.len() <= MAX_DELTA_BYTES && self.base_bytes + data.len() <= BASE_BYTES {
            self.base_bytes += data.len();
            self.bases.insert(id, (data.to_vec(), depth));
        }
        Ok(entry)
    }

    /// Records `id` written and lets go of partners' bases no version still needs.
    fn wrote(&mut self, id: ObjectId, partners: &[ObjectId]) {
        self.written.insert(id);
        for p in partners {
            let done = self
                .partners
                .get(p)
                .is_none_or(|qs| qs.iter().all(|q| self.written.contains(q)));
            if done && let Some((bytes, _)) = self.bases.remove(p) {
                self.base_bytes -= bytes.len();
            }
        }
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
        // The count, then the one wave's listing (trees kept from counting: no reads).
        let listed = |walk: Value| {
            let mut session = UploadSession::new(&walk).unwrap();
            assert_eq!(
                session.step(&json!({})).unwrap()["need_trees"],
                json!([tree])
            );
            let count = session.step(&trees).unwrap()["count"].clone();
            let wave = session.send(&json!({})).unwrap();
            assert_eq!(session.send(&json!({})).unwrap()["done"], true);
            (count, wave)
        };
        let (count, full) = listed(walk(false, json!([])));
        assert_eq!(count, 4);
        assert_eq!(full["trees"], json!([tree]));
        let (count, partial) = listed(walk(true, json!([])));
        assert_eq!(count, 2);
        assert_eq!(
            partial["fetch"],
            json!([{ "id": commit, "kind": "commit" }])
        );
        // A promisor fetch: the blob by id, no commit.
        let mut lazy = UploadSession::new(&json!({ "commits": [], "omit_blobs": true,
                                                   "objects": [kept] }))
        .unwrap();
        assert_eq!(lazy.step(&json!({})).unwrap()["count"], 1);
        let only = lazy.send(&json!({})).unwrap();
        assert_eq!(only["fetch"], json!([{ "id": kept, "kind": "blob" }]));
        assert_eq!(only["done"], true);
    }

    #[test]
    fn sends_wanted_tag_objects_from_the_walk() {
        let data = format!("object {}\ntype commit\ntag v1\n\nm\n", "c".repeat(40));
        let id = hash_object(ObjectKind::Tag, data.as_bytes());
        let tag = json!({ "id": id, "data_b64": STANDARD.encode(&data) });
        let mut session = UploadSession::new(&json!({ "commits": [], "tags": [tag] })).unwrap();
        assert_eq!(session.step(&json!({})).unwrap()["count"], 1);
        let listed = session.send(&json!({})).unwrap();
        assert_eq!(
            (&listed["tags"], &listed["fetch"], &listed["done"]),
            (&json!([id]), &json!([]), &json!(true))
        );
        session.pack_start().unwrap();
        assert!(session.pack_entry("tag", &id.hex(), None).is_ok());
        let wrong = json!({ "id": "d".repeat(40), "data_b64": STANDARD.encode(&data) });
        assert!(UploadSession::new(&json!({ "commits": [], "tags": [wrong] })).is_err());
    }

    #[test]
    fn sends_a_files_next_version_as_a_delta_git_resolves() {
        use yoneda_core::git_object::{PackLimits, PackReader};
        let versions: Vec<Vec<u8>> = (0..3)
            .map(|v| {
                let mut text = format!("## {v}\n").into_bytes();
                text.extend((0..2000).flat_map(|n| format!("- change {n}\n").into_bytes()));
                text
            })
            .collect();
        let blobs: Vec<ObjectId> = versions
            .iter()
            .map(|v| hash_object(ObjectKind::Blob, v))
            .collect();
        let trees: Vec<(ObjectId, Vec<u8>)> = blobs
            .iter()
            .map(|blob| {
                let entries = [TreeEntry {
                    name: "CHANGELOG.md".into(),
                    mode: FileMode::Blob,
                    id: *blob,
                }];
                let data = encode_tree(&entries).unwrap();
                (hash_object(ObjectKind::Tree, &data), data)
            })
            .collect();
        let commit = |n: usize| format!("{n}").repeat(40);
        let walk = json!({ "commits": [
            { "commit": commit(2), "tree": trees[2].0, "base_tree": trees[1].0 },
            { "commit": commit(1), "tree": trees[1].0, "base_tree": trees[0].0 },
            { "commit": commit(0), "tree": trees[0].0, "base_tree": null },
        ]});
        let mut session = UploadSession::new(&walk).unwrap();
        let supplied: Vec<Value> = trees
            .iter()
            .map(|(id, data)| json!({ "id": id, "data_b64": STANDARD.encode(data) }))
            .collect();
        assert_eq!(
            session.step(&json!({ "trees": supplied })).unwrap()["count"],
            9
        );
        assert_eq!(
            session.send(&json!({})).unwrap()["fetch"]
                .as_array()
                .unwrap()
                .len(),
            6
        );
        // The trees and files alone, the files oldest first (as a push's bundles hold
        // them): each later version is a small delta, and Git's reader resolves them all.
        session.count = 6;
        let mut pack = session.pack_start().unwrap();
        for (id, _) in &trees {
            pack.extend(session.pack_entry("tree", &id.hex(), None).unwrap());
        }
        let mut sizes = Vec::new();
        for (v, blob) in blobs.iter().enumerate() {
            let entry = session
                .pack_entry("blob", &blob.hex(), Some(&versions[v]))
                .unwrap();
            sizes.push(entry.len());
            pack.extend(entry);
        }
        assert!(
            sizes[0] > 1000 && sizes[1] < 100 && sizes[2] < 100,
            "{sizes:?}"
        );
        assert!(session.bases.is_empty());
        pack.extend(session.pack_finish().unwrap());
        let mut reader = PackReader::new(PackLimits::default(), 1 << 30);
        reader.feed(&pack).unwrap();
        reader.finish().unwrap();
        for (v, blob) in blobs.iter().enumerate() {
            assert_eq!(*reader.content(blob).unwrap(), versions[v]);
        }
    }
}

#[cfg(test)]
mod wave_tests {
    use super::*;

    /// `n` commits, each adding one file to a growing directory under a root tree.
    fn history(n: usize) -> (Value, HashMap<ObjectId, Vec<u8>>) {
        let mut trees = HashMap::new();
        let mut files = Vec::new();
        let mut commits = Vec::new();
        let mut base: Option<ObjectId> = None;
        for i in 0..n {
            files.push(TreeEntry {
                name: format!("f{i:05}"),
                mode: FileMode::Blob,
                id: hash_object(ObjectKind::Blob, format!("{i}\n").as_bytes()),
            });
            let dir = encode_tree(&files).unwrap();
            let dir_id = hash_object(ObjectKind::Tree, &dir);
            let root = encode_tree(&[TreeEntry {
                name: "d".into(),
                mode: FileMode::Tree,
                id: dir_id,
            }])
            .unwrap();
            let root_id = hash_object(ObjectKind::Tree, &root);
            trees.insert(dir_id, dir);
            trees.insert(root_id, root);
            commits.push(
                json!({ "commit": format!("{:040x}", i + 1), "tree": root_id, "base_tree": base }),
            );
            base = Some(root_id);
        }
        (json!({ "commits": commits }), trees)
    }

    /// Runs both passes, answering each `need_trees` from `trees`; the count, every listed
    /// object and the trees supplied.
    fn run(
        walk: &Value,
        trees: &HashMap<ObjectId, Vec<u8>>,
        drop: bool,
    ) -> (usize, Vec<String>, usize) {
        let supply = |need: &Value| {
            let listed: Vec<Value> = need
                .as_array()
                .unwrap()
                .iter()
                .map(|id| {
                    let id = ObjectId::parse(id.as_str().unwrap()).unwrap();
                    json!({ "id": id, "data_b64": STANDARD.encode(&trees[&id]) })
                })
                .collect();
            json!({ "trees": listed })
        };
        let mut session = UploadSession::new(walk).unwrap();
        // As past TREE_BYTES: each wave's trees go once it is walked.
        session.dropping = drop;
        let mut supplied = 0;
        let mut step = session.step(&json!({})).unwrap();
        while let Some(need) = step.get("need_trees") {
            supplied += need.as_array().unwrap().len();
            step = session.step(&supply(need)).unwrap();
        }
        let count = step["count"].as_u64().unwrap() as usize;
        let mut listed = Vec::new();
        loop {
            let mut wave = session.send(&json!({})).unwrap();
            while let Some(need) = wave.get("need_trees") {
                supplied += need.as_array().unwrap().len();
                wave = session.send(&supply(need)).unwrap();
            }
            for t in wave["trees"].as_array().unwrap() {
                listed.push(t.as_str().unwrap().to_owned());
            }
            for f in wave["fetch"].as_array().unwrap() {
                listed.push(f["id"].as_str().unwrap().to_owned());
            }
            if wave["done"] == true {
                break;
            }
        }
        (count, listed, supplied)
    }

    #[test]
    fn waves_list_every_object_once_and_count_it_first() {
        let commits = WAVE_COMMITS * 3 + 7;
        let (walk, trees) = history(commits);
        let (count, listed, supplied) = run(&walk, &trees, false);
        // Each commit: itself, a root and a directory tree, one new file.
        assert_eq!(count, commits * 4);
        assert_eq!(listed.len(), count);
        assert_eq!(
            listed.iter().collect::<HashSet<_>>().len(),
            count,
            "no object twice"
        );
        // Small enough to keep every tree: each read once.
        assert_eq!(supplied, commits * 2);
        // Trees let go wave by wave: the same pack, each tree read about twice (once per
        // pass) plus each wave's first base again.
        let (dropped, relisted, reread) = run(&walk, &trees, true);
        assert_eq!((dropped, relisted), (count, listed));
        let waves = commits.div_ceil(WAVE_COMMITS);
        assert!(reread <= 2 * (commits * 2 + waves * 2), "{reread}");
    }
}
