//! A fork and carrying its work back. Forking copies the parent's branches and tags (one
//! log entry each in the fork) and shares the commits. Fork work lands on the fork's
//! `feature` branch. Carrying it back records, oldest first, the commits the parent lacks
//! (those reachable from the fork branch and from none of the parent's tips or the refs
//! as copied), each based at its first-parent ancestry's earliest landing in the parent
//! (or a carried ancestor's base, else 0), then moves the parent's mirror branch
//! `forks/<fork>/feature` to the head, logged with the head's own paths. The parent
//! cannot be deleted while the fork lives; deleting the fork makes the parent forget it.
use crate::{Commit, CommitId, Outcome, Repo};
use std::collections::{BTreeMap, BTreeSet};

/// The fork's id, as the platform names it in the mirror branch.
pub const FORK_ID: &str = "r00000000000000000f01";
/// The fork's working branch, and the parent's mirror of it.
pub const FEATURE: &str = "refs/heads/feature";
pub const MIRROR: &str = "refs/heads/forks/r00000000000000000f01/feature";

#[derive(Clone, Debug)]
pub struct Fork {
    pub refs: BTreeMap<String, CommitId>,
    pub version: u64,
    /// Deleted by its owner (and forgotten by the parent).
    pub deleted: bool,
    /// The commits the refs named when copied.
    copied: BTreeSet<CommitId>,
}

impl Repo {
    pub(crate) fn fork_repo(&mut self) -> Outcome {
        if self.fork.is_some() {
            return Outcome::Already;
        }
        // The fork job starts from the parent's refs, refused until projected.
        if !self.unprojected.is_empty() {
            return Outcome::Refused("PROJECTION_PENDING");
        }
        let refs: BTreeMap<String, CommitId> = self.refs.clone();
        self.fork = Some(Fork {
            version: refs.len() as u64,
            deleted: false,
            copied: refs.values().copied().collect(),
            refs,
        });
        Outcome::Done
    }

    /// A one-file commit on the fork's `feature` (made from the fork's main when absent).
    pub(crate) fn fork_commit(&mut self, path: &str, content: &str) -> Outcome {
        let Some(fork) = self.fork.as_mut() else {
            return Outcome::Refused("NOT_FOUND");
        };
        if fork.deleted {
            return Outcome::Refused("GONE");
        }
        if !fork.refs.contains_key(FEATURE) {
            let Some(main) = fork.refs.get(crate::MAIN).copied() else {
                return Outcome::Refused("NOT_FOUND");
            };
            fork.version += 1;
            fork.refs.insert(FEATURE.to_owned(), main);
        }
        let parent = fork.refs[FEATURE];
        let mut tree = self.commits[parent].tree.clone();
        if tree.get(path).map(String::as_str) == Some(content) {
            return Outcome::Refused("NO_CHANGES");
        }
        tree.insert(path.to_owned(), content.to_owned());
        let id = self.commits.len();
        let base_version = fork.version;
        fork.version += 1;
        fork.refs.insert(FEATURE.to_owned(), id);
        self.commits.push(Commit {
            parents: vec![parent],
            tree,
            base_version,
            read_set: BTreeSet::new(),
            writes: BTreeSet::from([path.to_owned()]),
        });
        Outcome::Committed(id)
    }

    /// Where the parent bases a carried commit whose first parent is `parent`.
    fn carried_base(&self, mut at: Option<CommitId>) -> u64 {
        while let Some(commit) = at {
            let landed = self
                .landings
                .iter()
                .filter(|((c, _), _)| *c == commit)
                .map(|(_, v)| *v)
                .min();
            if let Some(version) = landed {
                return version;
            }
            if self.carried.contains(&commit) {
                return self.commits[commit].base_version;
            }
            at = self.commits[commit].parents.first().copied();
        }
        0
    }

    /// Brings the fork's `feature` into the parent as its mirror branch.
    pub(crate) fn carry(&mut self) -> Outcome {
        let Some(fork) = &self.fork else {
            return Outcome::Refused("NOT_FOUND");
        };
        // The carry starts from the parent's refs, refused until projected.
        if !self.unprojected.is_empty() {
            return Outcome::Refused("PROJECTION_PENDING");
        }
        if fork.deleted {
            return Outcome::Refused("GONE");
        }
        let Some(head) = fork.refs.get(FEATURE).copied() else {
            return Outcome::Refused("NOT_FOUND");
        };
        let mut known = BTreeSet::new();
        for tip in self.refs.values().chain(&fork.copied) {
            known.extend(self.ancestors(*tip));
        }
        let fresh: Vec<CommitId> = self
            .ancestors(head)
            .into_iter()
            .filter(|c| !known.contains(c))
            .collect();
        // Oldest first: a commit's number is after its parents'.
        for commit in fresh {
            let base = self.carried_base(self.commits[commit].parents.first().copied());
            self.commits[commit].base_version = base;
            self.carried.insert(commit);
        }
        if self.tip(MIRROR) == Some(head) {
            return Outcome::Already;
        }
        let paths = self.commits[head].writes.clone();
        self.move_ref(MIRROR, Some(head), paths, false);
        self.landed(head, MIRROR.to_owned());
        Outcome::Moved
    }

    /// The fork's owner deletes it; the parent then forgets it (a second delete answers
    /// already and forgets again).
    pub(crate) fn delete_fork(&mut self) -> Outcome {
        match self.fork.as_mut() {
            None => Outcome::Refused("NOT_FOUND"),
            Some(fork) if fork.deleted => Outcome::Already,
            Some(fork) => {
                fork.deleted = true;
                Outcome::Done
            }
        }
    }

    /// The owner deletes the repository, confirming its name: refused while a fork reads
    /// its objects (CONFLICT). Afterwards everything but the delete itself is GONE.
    pub(crate) fn delete_repo(&mut self, confirmed: bool) -> Outcome {
        if !confirmed {
            return Outcome::Refused("INVALID_INPUT");
        }
        if self.deleted {
            return Outcome::Already;
        }
        if self.fork.as_ref().is_some_and(|f| !f.deleted) {
            return Outcome::Refused("CONFLICT");
        }
        self.deleted = true;
        Outcome::Done
    }
}
