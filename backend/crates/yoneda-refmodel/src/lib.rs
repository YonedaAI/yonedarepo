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
//! - Files are one line each (the generator keeps them so), so a three-way merge is decided
//!   per file: a side that left a file alone takes the other's version; two different
//!   changes conflict.
mod access;
mod cases;
mod commits;
mod graph;
mod land;
mod merge;
mod queue;
mod tokens;

pub use access::{Access, Caller, Role};
pub use cases::{PATHS, Rng, generate};
pub use queue::{Batch, Ticket, TicketStatus};
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
    CreateBranch {
        name: String,
        from: String,
    },
    /// Moves `name` to `to`'s tip, expecting it at `expected`'s tip.
    MoveBranch {
        name: String,
        to: String,
        expected: String,
    },
    /// Deletes `name`, expecting it at `expected`'s tip.
    DeleteBranch {
        name: String,
        expected: String,
    },
    /// Creates tag `name` at `at`'s tip.
    Tag {
        name: String,
        at: String,
        /// With a message, an annotated tag (a tag object the platform builds).
        message: Option<String>,
    },
    /// Lands `branch`'s tip on main.
    Land {
        branch: String,
    },
    /// Reverts the commit `back` first parents below `branch`'s tip onto that tip and lands
    /// the revert on `branch`.
    Revert {
        branch: String,
        back: usize,
    },
    /// Lands `branch`'s tip on main; where main moved (merge required), through a platform
    /// merge commit of the two, as the adapter builds one.
    MergeLand {
        branch: String,
    },
    /// Replays working branch `branch`'s own commits onto main's head and moves it there.
    Rebase {
        branch: String,
    },
    /// `caller` tries `access`.
    Probe {
        caller: Caller,
        access: Access,
    },
    /// `caller` makes the repository public or private.
    SetVisibility {
        caller: Caller,
        public: bool,
    },
    /// The owner grants `account` `role`, or removes it (`None`).
    Member {
        account: String,
        role: Option<Role>,
    },
    /// Lands `branch`'s tip on main, queuing it where a merge is required.
    Enqueue {
        branch: String,
    },
    /// The combiner settles one batch of main's queue.
    RunQueue,
    /// The owner mints repository token `name` with `scopes` and an optional path grant.
    MintToken {
        name: String,
        scopes: BTreeSet<Scope>,
        grant: Option<Vec<String>>,
    },
    RevokeToken {
        name: String,
    },
    /// A one-file commit on `branch` as token `token`, landed there.
    TokenCommit {
        token: String,
        branch: String,
        path: String,
        content: Option<String>,
    },
    /// Token `token` reads `path`'s history on main.
    TokenRead {
        token: String,
        path: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A new commit, landed on its branch (or main, for a merge).
    Committed(CommitId),
    /// A rebase moved its branch, through these replayed commits (oldest first).
    Rebased(Vec<CommitId>),
    /// A ref moved, was created or deleted.
    Moved,
    /// Nothing to do: the ref is already there (or already gone).
    Already,
    /// A landing ticket (new, or the one already pending for the commit).
    Queued(u64),
    /// What a combiner run settled.
    Batch(Batch),
    /// Done, moving no ref (an access check, visibility, membership).
    Done,
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
    pub(crate) landings: BTreeSet<(CommitId, String)>,
    pub public: bool,
    /// Member accounts and their roles (the owner is not one).
    pub members: BTreeMap<String, Role>,
    /// Main's landing queue, every ticket ever issued.
    pub tickets: Vec<Ticket>,
    /// Repository tokens by name, revoked ones included (names are never reused).
    pub tokens: BTreeMap<String, Token>,
    /// Annotated tags' messages, by tag ref.
    pub annotated: BTreeMap<String, String>,
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
            }],
            landings: BTreeSet::from([(0, MAIN.to_owned())]),
            public: false,
            members: BTreeMap::new(),
            tickets: Vec::new(),
            tokens: BTreeMap::new(),
            annotated: BTreeMap::new(),
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
            Op::Tag { name, at, message } => match self.tip(at) {
                Some(target) => (self.tag(name, target, message.as_deref()), None),
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
            Op::MergeLand { branch } => match self.tip(branch) {
                Some(commit) => {
                    let plan = self.plan(commit);
                    (self.merge_land(commit), Some(plan))
                }
                None => (Outcome::Refused("NOT_FOUND"), None),
            },
            Op::Rebase { branch } => (self.rebase(branch), None),
            Op::Probe { caller, access } => (self.access(caller, *access), None),
            Op::SetVisibility { caller, public } => (self.set_visibility(caller, *public), None),
            Op::Member { account, role } => (self.set_member(account, *role), None),
            Op::Enqueue { branch } => (self.enqueue(branch), None),
            Op::RunQueue => (self.run_queue(), None),
            Op::MintToken {
                name,
                scopes,
                grant,
            } => (self.mint(name, scopes, grant), None),
            Op::RevokeToken { name } => (self.revoke(name), None),
            Op::TokenCommit {
                token,
                branch,
                path,
                content,
            } => (
                self.token_commit(token, branch, path, content.as_deref()),
                None,
            ),
            Op::TokenRead { token, path } => (self.token_read(token, path), None),
        }
    }

    /// `repo_branch_set`: a working branch moves to `target` if it is at `expected`.
    pub(crate) fn set(
        &mut self,
        name: &str,
        target: CommitId,
        expected: Option<CommitId>,
    ) -> Outcome {
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

    /// A tag is created once. Asking again for the same lightweight tag is a no-op; any
    /// other second request is refused, an annotated one too (its tag object, tagged
    /// later, is a different object).
    fn tag(&mut self, name: &str, target: CommitId, message: Option<&str>) -> Outcome {
        match self.tip(name) {
            Some(current)
                if current == target && message.is_none() && !self.annotated.contains_key(name) =>
            {
                Outcome::Already
            }
            Some(_) => Outcome::Refused("ALREADY_EXISTS"),
            None => {
                self.move_ref(name, Some(target), BTreeSet::new(), false);
                if let Some(text) = message {
                    self.annotated.insert(name.to_owned(), text.to_owned());
                }
                Outcome::Moved
            }
        }
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
