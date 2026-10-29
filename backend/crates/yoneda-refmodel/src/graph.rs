//! Ancestry over the model's commit graph.
use crate::{CommitId, Repo};
use std::collections::BTreeSet;

impl Repo {
    /// `commit` and its first parents, nearest first.
    pub fn first_parents(&self, commit: CommitId) -> Vec<CommitId> {
        let mut out = vec![commit];
        while let Some(&parent) = out.last().and_then(|c| self.commits[*c].parents.first()) {
            out.push(parent);
        }
        out
    }

    /// `commit` and every commit reachable from it.
    pub fn ancestors(&self, commit: CommitId) -> BTreeSet<CommitId> {
        let mut seen = BTreeSet::new();
        let mut stack = vec![commit];
        while let Some(id) = stack.pop() {
            if seen.insert(id) {
                stack.extend(&self.commits[id].parents);
            }
        }
        seen
    }

    /// Whether `ancestor` is a proper ancestor of `commit`.
    pub fn is_ancestor(&self, ancestor: CommitId, commit: CommitId) -> bool {
        ancestor != commit && self.ancestors(commit).contains(&ancestor)
    }

    /// The best common ancestors of `left` and `right` (Git's `merge-base --all`): common
    /// ancestors (each commit counting as its own) that no other common ancestor descends from.
    pub fn merge_bases(&self, left: CommitId, right: CommitId) -> BTreeSet<CommitId> {
        let theirs = self.ancestors(right);
        let common: Vec<CommitId> = self
            .ancestors(left)
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
