//! The operations the model and the differential tests share, what each answers, and
//! how the model applies them.
use crate::{Access, Batch, Caller, CommitId, Repo, Role, Scope, Submitted};
use std::collections::BTreeSet;

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
    /// Lands `branch`'s tip on working branch `onto` (no gates, the write scope).
    LandOn {
        branch: String,
        onto: String,
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
    /// `by` grants `account` `role`, or removes it (`None`).
    Member {
        by: Caller,
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
    /// Takes main's published head (its commit and the version it reflects), as a cache
    /// holds it; later shard commits begin there, however far main has moved since.
    Publish,
    /// A commit built statelessly on the published head and kept only in its commit
    /// shard (the authority knows nothing of it yet).
    ShardCommit {
        path: String,
        content: String,
        read: bool,
    },
    /// The combiner submits these shard commits (indexes into `shard`, in order) to land
    /// on main, then the projector builds main's Git commit for what landed.
    Submit {
        picks: Vec<usize>,
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
    /// What a submission answered for each landing, and the commit projection made.
    Submitted(Submitted),
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

impl Repo {
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
            Op::LandOn { branch, onto } => (self.land_onto(branch, onto), None),
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
            Op::Member { by, account, role } => (self.set_member(by, account, *role), None),
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
            Op::Publish => (self.publish(), None),
            Op::ShardCommit {
                path,
                content,
                read,
            } => (self.shard_commit(path, content, *read), None),
            Op::Submit { picks } => (self.submit(picks), None),
        }
    }
}
