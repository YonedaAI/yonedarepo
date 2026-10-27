//! Verifies a pushed pack before anything moves: the new commits are those in the pack
//! reachable from the pushed tips; each is diffed against its first parent, descending only
//! into directories that differ, so whatever it leaves unchanged is covered by a parent
//! that is already verified or recorded. Every tree or file a new commit introduces must be
//! in the pack (and of the right kind) or held by the repository: trees the walk needs are
//! read through the adapter (which proves they exist), and files outside the pack are
//! confirmed by the adapter one by one. The same diff yields each commit's path touches.
use crate::platform_objects::{entry_type, new_trees};
use crate::secret_scan::{SecretAllow, scan};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::{
        Commit, FileMode, ObjectId, ObjectKind, PackReader, TreeChange, TreeEntry, Walk,
        decode_tree, diff_trees,
    },
    txlog::{PathOp, PathTouch},
};

/// Changed files one pushed commit may carry (an initial push lists every file).
const MAX_FILES: usize = 100_000;
/// Files outside the pack the adapter may be asked to confirm, per push.
const MAX_CONFIRM: usize = 10_000;

/// What verification learned from the adapter so far.
#[derive(Default)]
pub struct Verifier {
    trees: HashMap<ObjectId, Vec<TreeEntry>>,
    pack_trees: bool,
    present: HashSet<ObjectId>,
    /// Recorded commits outside the pack that new commits name as parents: their trees.
    external: HashMap<ObjectId, ObjectId>,
    /// The repository policy's accepted false positives, and the (path, blob) pairs scanned.
    pub secret_allow: Vec<SecretAllow>,
    scanned: HashSet<(String, ObjectId)>,
}

/// A verified new commit, ready to record.
pub struct Verified {
    pub commit: ObjectId,
    pub touches: Vec<PathTouch>,
    /// Objects this commit introduces from the pack (the commit first).
    pub objects: Vec<(ObjectId, ObjectKind)>,
}

pub enum Step {
    /// Ask the adapter for these (`{commits}`, `{trees}` or `{objects}`), then verify again.
    Need(Value),
    Done(Vec<Verified>),
}

struct Parsed {
    tree: ObjectId,
    parents: Vec<ObjectId>,
}

impl Verifier {
    /// A recorded parent's tree, as the authority reported it.
    pub fn add_commit(&mut self, commit: ObjectId, tree: ObjectId) {
        self.external.insert(commit, tree);
    }
    pub fn add_tree(&mut self, id: ObjectId, entries: Vec<TreeEntry>) {
        self.trees.insert(id, entries);
    }
    pub fn add_present(&mut self, id: ObjectId) {
        self.present.insert(id);
    }

    pub fn verify(&mut self, pack: &mut PackReader, tips: &[ObjectId]) -> Result<Step> {
        if !self.pack_trees {
            let ids: Vec<ObjectId> = pack
                .objects()
                .filter(|(_, kind)| *kind == ObjectKind::Tree)
                .map(|(id, _)| id)
                .collect();
            for id in ids {
                let data = pack.kept(&id).ok_or_else(|| invalid_object(&id))?;
                let entries = decode_tree(data)
                    .map_err(|e| Error::new(&e.code, format!("Tree {id}: {}", e.message)))?;
                self.trees.insert(id, entries);
            }
            self.pack_trees = true;
        }
        let (order, parsed) = new_commits(pack, tips)?;
        let unknown: BTreeSet<ObjectId> = parsed
            .values()
            .flat_map(|p| p.parents.iter())
            .filter(|p| !parsed.contains_key(p) && !self.external.contains_key(p))
            .copied()
            .collect();
        if !unknown.is_empty() {
            return Ok(Step::Need(json!({ "commits": unknown })));
        }
        let tree_of = |id: &ObjectId| {
            parsed
                .get(id)
                .map(|p| p.tree)
                .or(self.external.get(id).copied())
        };
        // Every diff first, so one round asks for every tree any commit needs.
        let mut need = BTreeSet::new();
        let mut diffs: HashMap<ObjectId, Vec<Vec<TreeChange>>> = HashMap::new();
        for id in &order {
            let commit = &parsed[id];
            let bases: Vec<Option<ObjectId>> = if commit.parents.is_empty() {
                vec![None]
            } else {
                commit.parents.iter().map(tree_of).collect()
            };
            let mut sides = Vec::new();
            for base in bases {
                match diff_trees(base, Some(commit.tree), &self.trees, MAX_FILES)? {
                    Walk::Need(ids) => need.extend(ids),
                    Walk::Done(changes) => sides.push(changes),
                }
            }
            diffs.insert(*id, sides);
        }
        if !need.is_empty() {
            return Ok(Step::Need(json!({ "trees": need })));
        }
        let mut assigned = HashSet::new();
        let mut confirm = BTreeSet::new();
        let mut verified = Vec::with_capacity(order.len());
        for id in &order {
            let commit = &parsed[id];
            let sides = &diffs[id];
            let mut objects = vec![(*id, ObjectKind::Commit)];
            assigned.insert(*id);
            for tree in new_trees(commit.tree, &sides[0], &self.trees) {
                // Trees outside the pack were read from the repository: they exist.
                claim(pack, &mut assigned, &mut objects, tree, ObjectKind::Tree)?;
            }
            for change in &sides[0] {
                let Some((mode, blob)) = change.new else {
                    continue;
                };
                if mode == FileMode::Gitlink {
                    continue;
                }
                if claim(pack, &mut assigned, &mut objects, blob, ObjectKind::Blob)? {
                    // Every file the push carries is scanned at each path it lands on.
                    if self.scanned.insert((change.path.clone(), blob)) {
                        let content = pack.content(&blob)?;
                        scan(&change.path, &content, &self.secret_allow)
                            .map_err(|e| secret_found(&change.path, e))?;
                    }
                    continue;
                }
                // Equal to another parent's file at this path: held with that parent.
                let inherited = sides[1..]
                    .iter()
                    .any(|other| !other.iter().any(|c| c.path == change.path));
                if !inherited && !self.present.contains(&blob) {
                    confirm.insert(blob);
                }
            }
            verified.push(Verified {
                commit: *id,
                touches: sides[0].iter().map(touch).collect(),
                objects,
            });
        }
        if confirm.len() > MAX_CONFIRM {
            return Err(Error::new(
                "TOO_LARGE",
                "The push names too many files it does not carry",
            ));
        }
        if !confirm.is_empty() {
            return Ok(Step::Need(json!({ "objects": confirm })));
        }
        Ok(Step::Done(verified))
    }
}

/// `SECRET_DETECTED` naming only the path and line (the scanner's message names the rule
/// and how to allow it, never the secret).
fn secret_found(path: &str, e: Error) -> Error {
    let line = e
        .message
        .strip_prefix(&format!("{path} line "))
        .and_then(|rest| rest.split(' ').next())
        .unwrap_or("?");
    Error::new(&e.code, format!("secret detected in {path}:{line}"))
}

fn invalid_object(id: &ObjectId) -> Error {
    Error::new("GIT_OBJECT_INVALID", format!("Object {id} is unreadable"))
}

/// Whether `id` is in the pack (as `kind`, or the push is refused); the first commit to
/// name a pack object introduces it.
fn claim(
    pack: &PackReader,
    assigned: &mut HashSet<ObjectId>,
    objects: &mut Vec<(ObjectId, ObjectKind)>,
    id: ObjectId,
    kind: ObjectKind,
) -> Result<bool> {
    match pack.kind(&id) {
        None => Ok(false),
        Some(found) if found != kind => Err(Error::new(
            "GIT_OBJECT_INVALID",
            format!("{id} is a {}, not a {}", found.name(), kind.name()),
        )),
        Some(_) => {
            if assigned.insert(id) {
                objects.push((id, kind));
            }
            Ok(true)
        }
    }
}

/// The pack's commits reachable from `tips` through pack commits, parents first.
fn new_commits(
    pack: &PackReader,
    tips: &[ObjectId],
) -> Result<(Vec<ObjectId>, HashMap<ObjectId, Parsed>)> {
    let mut parsed: HashMap<ObjectId, Parsed> = HashMap::new();
    let mut order = Vec::new();
    let mut done = HashSet::new();
    for tip in tips {
        match pack.kind(tip) {
            None => continue, // already recorded, or refused when its ref moves
            Some(ObjectKind::Commit) => {}
            Some(kind) => {
                return Err(Error::new(
                    "INVALID_INPUT",
                    format!(
                        "{tip} is a {}; only commits can be pushed to branches",
                        kind.name()
                    ),
                ));
            }
        }
        // Iterative post-order: a commit is ordered after all of its pack parents.
        let mut stack = vec![(*tip, false)];
        while let Some((id, expanded)) = stack.pop() {
            if done.contains(&id) {
                continue;
            }
            if expanded {
                done.insert(id);
                order.push(id);
                continue;
            }
            let data = pack.kept(&id).ok_or_else(|| invalid_object(&id))?;
            let commit = Commit::decode(data)
                .map_err(|e| Error::new(&e.code, format!("Commit {id}: {}", e.message)))?;
            let parents = commit.parents()?;
            stack.push((id, true));
            for parent in &parents {
                if pack.kind(parent) == Some(ObjectKind::Commit) && !done.contains(parent) {
                    stack.push((*parent, false));
                }
            }
            parsed.insert(
                id,
                Parsed {
                    tree: commit.tree()?,
                    parents,
                },
            );
        }
    }
    Ok((order, parsed))
}

fn touch(change: &TreeChange) -> PathTouch {
    let mode = |side: Option<(FileMode, ObjectId)>| {
        side.filter(|(m, _)| *m != FileMode::Gitlink)
            .map(|(m, _)| entry_type(m).to_owned())
    };
    PathTouch {
        path: change.path.clone(),
        op: match (change.old, change.new) {
            (None, _) => PathOp::Add,
            (_, None) => PathOp::Delete,
            _ => PathOp::Modify,
        },
        old_blob: change.old.map(|(_, id)| id),
        new_blob: change.new.map(|(_, id)| id),
        mode: mode(change.new),
    }
}
