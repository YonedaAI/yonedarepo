//! A reference model of one YonedaRepo repository: refs, commits as whole file trees, the
//! global log version, and the operations the differential tests drive (a one-file commit
//! landed on its branch, working-branch create, move and delete by compare-and-swap, tags,
//! landing a branch on main with its merge-plan outcome, reverts, platform merge commits
//! and rebases, queued landings, tokens, and who may read and write). It has no dependencies, so
//! it shares no code with the platform it checks; commits are numbered in creation order
//! and the test maps those numbers to Git ids.
//!
//! The rules modelled (from the platform's documented contracts):
//! - Every ref move (landing, branch set or delete, tag creation) appends one log entry and
//!   advances the version by one; a no-op (`already`) and a refusal advance nothing.
//! - Main is protected: it moves only by landing. Tags (lightweight, or annotated with a
//!   tag object) are created once and never move.
//! - A landing whose target head is the commit's parent or an ancestor of it fast-forwards.
//!   Otherwise optimistic concurrency decides against main's entries after the commit's base
//!   version: one writing a path the commit read is a conflict; none is a stale parent;
//!   entries writing other paths need a rebase, the same paths a merge.
//! - A private repository exists only for its owner and members; a public one is read by
//!   anyone, and written only by write members and the owner (`access`).
//! - Landings queued on main settle in batches: a fast-forward alone, else one octopus merge
//!   of the independent clean merges (`queue`); while any wait, direct landings on main
//!   are refused as MERGE_REQUIRED.
//! - Repository tokens act within their scopes and path grant (`tokens`).
//! - Commits may begin from a published head that trails the log and land through the
//!   combiner as changesets, or the merge path, decided against everything landed since
//!   (`shards`).
//! - A fork shares the commits; carrying its work back records what the parent lacks and
//!   moves the parent's mirror branch (`forks`).
//! - Files are one line each (the generator keeps them so), so a three-way merge is decided
//!   per file: a side that left a file alone takes the other's version; two different
//!   changes conflict.
mod access;
mod branches;
mod cases;
mod commits;
mod forks;
mod graph;
mod land;
mod merge;
mod ops;
mod queue;
mod shards;
mod tokens;

pub use access::{Access, Caller, Role};
pub use cases::{PATHS, Rng, generate};
pub use forks::{FEATURE, FORK_ID, Fork, MIRROR};
pub use ops::{Op, Outcome, Plan};
pub use queue::{Batch, Ticket, TicketStatus};
pub use shards::{Item, Submitted};
use std::collections::{BTreeMap, BTreeSet};
pub use tokens::{Scope, Token};

/// A commit's number: its position in creation order (0 is the seeded root).
pub type CommitId = usize;
/// A whole tree: file path to content.
pub type Tree = BTreeMap<String, String>;

pub const MAIN: &str = "refs/heads/main";

#[derive(Clone, Debug)]
pub struct Commit {
    /// First parent first; a platform merge commit has the merged commit second.
    pub parents: Vec<CommitId>,
    pub tree: Tree,
    /// The log version its author read.
    pub base_version: u64,
    pub read_set: BTreeSet<String>,
    /// Paths it changed against its first parent.
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
    /// The ref's commit after it (`None`: deleted, or a changeset not projected yet).
    pub head: Option<CommitId>,
}

#[derive(Clone, Debug)]
pub struct Repo {
    pub version: u64,
    pub commits: Vec<Commit>,
    pub refs: BTreeMap<String, CommitId>,
    pub log: Vec<Entry>,
    /// Commits recorded as landed on a ref, with the version they first landed at.
    pub(crate) landings: BTreeMap<(CommitId, String), u64>,
    pub public: bool,
    /// Member accounts and their roles (the owner is not one).
    pub members: BTreeMap<String, Role>,
    /// Main's landing queue, every ticket ever issued.
    pub tickets: Vec<Ticket>,
    /// Repository tokens by name, revoked ones included (names are never reused).
    pub tokens: BTreeMap<String, Token>,
    /// Annotated tags' messages, by tag ref.
    pub annotated: BTreeMap<String, String>,
    /// Main's published head as last taken: its commit and the version it reflects.
    pub published: (CommitId, u64),
    /// Shard commits, in the order they were built.
    pub shard: Vec<CommitId>,
    /// Shard commits the authority does not hold (not adopted, nor landed and projected).
    pub unrecorded: BTreeSet<CommitId>,
    /// Submissions' changesets the projector has yet to build, as (version, commit).
    pub unprojected: Vec<Vec<(u64, CommitId)>>,
    /// The fork, once made.
    pub fork: Option<Fork>,
    /// Commits carried in from the fork (recorded as pushed).
    pub carried: BTreeSet<CommitId>,
    /// Deleted by its owner: the authority answers GONE to all but the delete.
    pub deleted: bool,
}

impl Repo {
    /// A repository whose main is `root` (a tree) imported at version 1.
    pub fn seeded(root: Tree) -> Self {
        let paths: BTreeSet<String> = root.keys().cloned().collect();
        let commit = Commit {
            parents: vec![],
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
                head: Some(0),
            }],
            landings: BTreeMap::from([((0, MAIN.to_owned()), 1)]),
            public: false,
            members: BTreeMap::new(),
            tickets: Vec::new(),
            tokens: BTreeMap::new(),
            annotated: BTreeMap::new(),
            published: (0, 1),
            shard: Vec::new(),
            unrecorded: BTreeSet::new(),
            unprojected: Vec::new(),
            fork: None,
            carried: BTreeSet::new(),
            deleted: false,
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

    /// Appends the log entry for `refname` moving to `target` (`None`: deleted) and moves it.
    pub(crate) fn move_ref(
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
            head: target,
        });
        match target {
            Some(id) => self.refs.insert(refname.to_owned(), id),
            None => self.refs.remove(refname),
        };
    }

    /// Records `commit` as landed on `refname` at the current version (the first landing
    /// counts).
    pub(crate) fn landed(&mut self, commit: CommitId, refname: String) {
        self.landings
            .entry((commit, refname))
            .or_insert(self.version);
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
