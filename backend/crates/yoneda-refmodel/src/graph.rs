//! Ancestry over the model's commits (each has at most one parent).
use crate::{CommitId, Repo};
use std::collections::BTreeSet;

impl Repo {
    /// `commit` and its ancestors, nearest first.
    pub fn ancestry(&self, commit: CommitId) -> Vec<CommitId> {
        let mut out = vec![commit];
        while let Some(parent) = self.commits[*out.last().unwrap_or(&commit)].parent {
            out.push(parent);
        }
        out
    }

    /// Whether `ancestor` is a proper ancestor of `commit`.
    pub fn is_ancestor(&self, ancestor: CommitId, commit: CommitId) -> bool {
        ancestor != commit && self.ancestry(commit).contains(&ancestor)
    }

    /// The best common ancestors of `left` and `right` (Git's `merge-base --all`): common
    /// ancestors (each commit counting as its own) that no other common ancestor descends from.
    pub fn merge_bases(&self, left: CommitId, right: CommitId) -> BTreeSet<CommitId> {
        let theirs: BTreeSet<CommitId> = self.ancestry(right).into_iter().collect();
        let common: Vec<CommitId> = self
            .ancestry(left)
            .into_iter()
            .filter(|c| theirs.contains(c))
            .collect();
        common
            .iter()
            .copied()
            .filter(|c| !common.iter().any(|other| self.is_ancestor(*c, *other)))
            .collect()
    }
}
