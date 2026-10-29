//! A reference model of one YonedaRepo repository: refs, commits as whole file trees, the
//! global log version, and the operations the differential tests drive (a one-file commit
//! landed on its branch, working-branch create, move and delete by compare-and-swap, tags,
//! landing a branch on main with its merge-plan outcome, and reverts). It has no dependencies, so
//! it shares no code with the platform it checks; commits are numbered in creation order
//! and the test maps those numbers to Git ids.
//!
//! The rules modelled (from the platform's documented contracts):
//! - Every ref move (landing, branch set or delete, tag creation) appends one log entry and
//!   advances the version by one; a no-op (`already`) and a refusal advance nothing.
//! - Main is protected: it moves only by landing. Tags are created once and never move.
//! - A landing whose target head is the commit's parent or an ancestor of it fast-forwards.
//!   Otherwise optimistic concurrency decides against main's entries after the commit's base
//!   version: one writing a path the commit read is a conflict; none is a stale parent;
//!   entries writing other paths need a rebase, the same paths a merge.
mod cases;
mod graph;
mod land;

pub use cases::{PATHS, Rng, generate};
use std::collections::{BTreeMap, BTreeSet};

/// A commit's number: its position in creation order (0 is the seeded root).
pub type CommitId = usize;
/// A whole tree: file path to content.
pub type Tree = BTreeMap<String, String>;

pub const MAIN: &str = "refs/heads/main";

#[derive(Clone, Debug)]
pub struct Commit {
    pub parent: Option<CommitId>,
    pub tree: Tree,
    /// The log version its author read.
    pub base_version: u64,
    pub read_set: BTreeSet<String>,
    /// Paths it changed against its parent.
    pub writes: BTreeSet<String>,
}

/// One log entry: the version it made, the ref it moved, the paths it changed (empty for a
/// branch or tag move), and whether it was a landing (as opposed to a ref move).
#[derive(Clone, Debug)]
pub struct Entry {
    pub version: u64,
    pub refname: String,
    pub paths: BTreeSet<String>,
    pub landing: bool,
}

/// An operation; refs are named in full (`refs/heads/b1`, `refs/tags/v1`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    /// Puts (`Some`) or deletes one file on `branch`'s tip, reading `path` when `read`, and
    /// lands the commit on `branch`.
    Commit {
        branch: String,
        path: String,
        content: Option<String>,
        read: bool,
    },
    /// Creates working branch `name` at `from`'s tip, expecting it absent.
    CreateBranch { name: String, from: String },
    /// Moves `name` to `to`'s tip, expecting it at `expected`'s tip.
    MoveBranch {
        name: String,
        to: String,
        expected: String,
    },
    /// Deletes `name`, expecting it at `expected`'s tip.
    DeleteBranch { name: String, expected: String },
    /// Creates tag `name` at `at`'s tip.
    Tag { name: String, at: String },
    /// Lands `branch`'s tip on main.
    Land { branch: String },
    /// Reverts the commit `back` first parents below `branch`'s tip onto that tip and lands
    /// the revert on `branch`.
    Revert { branch: String, back: usize },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A new commit, landed on its branch.
    Committed(CommitId),
    /// A ref moved, was created or deleted.
    Moved,
    /// Nothing to do: the ref is already there (or already gone).
    Already,
    /// Refused with the platform's error code (`STALE_HEAD` also for a stale batch delete).
    Refused(&'static str),
}

/// What `repo_merge_plan` decides for landing a commit on main.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub kind: &'static str,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Repo {
    pub version: u64,
    pub commits: Vec<Commit>,
    pub refs: BTreeMap<String, CommitId>,
    pub log: Vec<Entry>,
    /// Commits recorded as landed on a ref.
    landings: BTreeSet<(CommitId, String)>,
}

impl Repo {
    /// A repository whose main is `root` (a tree) imported at version 1.
    pub fn seeded(root: Tree) -> Self {
        let paths: BTreeSet<String> = root.keys().cloned().collect();
        let commit = Commit {
            parent: None,
            tree: root,
            base_version: 0,
            read_set: BTreeSet::new(),
            writes: paths.clone(),
        };
        Self {
            version: 1,
            commits: vec![commit],
            refs: BTreeMap::from([(MAIN.to_owned(), 0)]),
            log: vec![Entry {
                version: 1,
                refname: MAIN.to_owned(),
                paths,
                landing: true,
            }],
            landings: BTreeSet::from([(0, MAIN.to_owned())]),
        }
    }

    pub fn tip(&self, refname: &str) -> Option<CommitId> {
        self.refs.get(refname).copied()
    }

    /// Main and release branches move only by landing.
    pub fn protected(refname: &str) -> bool {
        refname == MAIN
            || refname == "refs/heads/release"
            || refname.starts_with("refs/heads/release/")
    }

    /// Applies `op`; a landing also answers its merge plan, taken before it lands.
    pub fn apply(&mut self, op: &Op) -> (Outcome, Option<Plan>) {
        match op {
            Op::Commit {
                branch,
                path,
                content,
                read,
            } => (self.commit(branch, path, content.as_deref(), *read), None),
            Op::CreateBranch { name, from } => match self.tip(from) {
                Some(target) => (self.set(name, target, None), None),
                None => (Outcome::Refused("NOT_FOUND"), None),
            },
            Op::MoveBranch { name, to, expected } => match self.tip(to) {
                Some(target) => (self.set(name, target, self.tip(expected)), None),
                None => (Outcome::Refused("NOT_FOUND"), None),
            },
            Op::DeleteBranch { name, expected } => (self.delete(name, self.tip(expected)), None),
            Op::Tag { name, at } => match self.tip(at) {
                Some(target) => (self.tag(name, target), None),
                None => (Outcome::Refused("NOT_FOUND"), None),
            },
            Op::Land { branch } => match self.tip(branch) {
                Some(commit) => {
                    let plan = self.plan(commit);
                    (self.land(commit), Some(plan))
                }
                None => (Outcome::Refused("NOT_FOUND"), None),
            },
            Op::Revert { branch, back } => (self.revert(branch, *back), None),
        }
    }

    fn commit(&mut self, branch: &str, path: &str, content: Option<&str>, read: bool) -> Outcome {
        let Some(parent) = self.tip(branch) else {
            return Outcome::Refused("NOT_FOUND");
        };
        let mut tree = self.commits[parent].tree.clone();
        let changed = match content {
            Some(text) => tree.insert(path.to_owned(), text.to_owned()).as_deref() != Some(text),
            None => tree.remove(path).is_some(),
        };
        if !changed {
            return Outcome::Refused(if content.is_some() {
                "NO_CHANGES"
            } else {
                "NOT_FOUND"
            });
        }
        let reads = if read {
            BTreeSet::from([path.to_owned()])
        } else {
            BTreeSet::new()
        };
        self.record(
            branch,
            parent,
            tree,
            reads,
            BTreeSet::from([path.to_owned()]),
        )
    }

    /// A revert: each path the source changed against its parent goes back to the parent's
    /// content, provided the tip still holds the source's (else the paths conflict).
    fn revert(&mut self, branch: &str, back: usize) -> Outcome {
        let Some(tip) = self.tip(branch) else {
            return Outcome::Refused("NOT_FOUND");
        };
        let Some(source) = self.ancestry(tip).get(back).copied() else {
            return Outcome::Refused("NOT_FOUND");
        };
        let Some(parent) = self.commits[source].parent else {
            return Outcome::Refused("INVALID_INPUT");
        };
        let (before, after) = (&self.commits[parent].tree, &self.commits[source].tree);
        let changed = Self::changed(before, after);
        let mut tree = self.commits[tip].tree.clone();
        if changed.iter().any(|path| tree.get(path) != after.get(path)) {
            return Outcome::Refused("CONFLICT");
        }
        for path in &changed {
            match before.get(path) {
                Some(text) => tree.insert(path.clone(), text.clone()),
                None => tree.remove(path),
            };
        }
        self.record(branch, tip, tree, BTreeSet::new(), changed)
    }

    /// A new commit of `tree` on `parent` (`branch`'s tip), landed on `branch`.
    fn record(
        &mut self,
        branch: &str,
        parent: CommitId,
        tree: Tree,
        read_set: BTreeSet<String>,
        writes: BTreeSet<String>,
    ) -> Outcome {
        let id = self.commits.len();
        self.commits.push(Commit {
            parent: Some(parent),
            tree,
            base_version: self.version,
            read_set,
            writes,
        });
        // Built on the branch's tip, it always fast-forwards there.
        match self.land_on(branch, id) {
            Outcome::Moved => Outcome::Committed(id),
            other => other,
        }
    }

    /// `repo_branch_set`: a working branch moves to `target` if it is at `expected`.
    fn set(&mut self, name: &str, target: CommitId, expected: Option<CommitId>) -> Outcome {
        if Self::protected(name) {
            return Outcome::Refused("FORBIDDEN");
        }
        let current = self.tip(name);
        if current == Some(target) {
            return Outcome::Already;
        }
        if current != expected {
            return Outcome::Refused("STALE_HEAD");
        }
        self.move_ref(name, Some(target), BTreeSet::new(), false);
        Outcome::Moved
    }

    /// A deletion through `repo_branch_batch` (a null commit).
    fn delete(&mut self, name: &str, expected: Option<CommitId>) -> Outcome {
        if Self::protected(name) {
            return Outcome::Refused("FORBIDDEN");
        }
        match self.tip(name) {
            None => Outcome::Already,
            Some(current) if Some(current) != expected => Outcome::Refused("STALE_HEAD"),
            Some(_) => {
                self.move_ref(name, None, BTreeSet::new(), false);
                Outcome::Moved
            }
        }
    }

    fn tag(&mut self, name: &str, target: CommitId) -> Outcome {
        match self.tip(name) {
            Some(current) if current == target => Outcome::Already,
            Some(_) => Outcome::Refused("ALREADY_EXISTS"),
            None => {
                self.move_ref(name, Some(target), BTreeSet::new(), false);
                Outcome::Moved
            }
        }
    }

    /// Appends the log entry for `refname` moving to `target` (`None`: deleted) and moves it.
    fn move_ref(
        &mut self,
        refname: &str,
        target: Option<CommitId>,
        paths: BTreeSet<String>,
        landing: bool,
    ) {
        self.version += 1;
        self.log.push(Entry {
            version: self.version,
            refname: refname.to_owned(),
            paths,
            landing,
        });
        match target {
            Some(id) => self.refs.insert(refname.to_owned(), id),
            None => self.refs.remove(refname),
        };
    }

    /// Paths whose content differs between two trees.
    pub fn changed(old: &Tree, new: &Tree) -> BTreeSet<String> {
        old.keys()
            .chain(new.keys())
            .filter(|path| old.get(*path) != new.get(*path))
            .cloned()
            .collect()
    }
}
