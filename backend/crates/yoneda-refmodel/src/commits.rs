//! New commits on a branch's tip, landed there: a one-file change, or a revert.
use crate::{Commit, CommitId, Outcome, Repo, Tree};
use std::collections::BTreeSet;

impl Repo {
    pub(crate) fn commit(
        &mut self,
        branch: &str,
        path: &str,
        content: Option<&str>,
        read: bool,
    ) -> Outcome {
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
    pub(crate) fn revert(&mut self, branch: &str, back: usize) -> Outcome {
        let Some(tip) = self.tip(branch) else {
            return Outcome::Refused("NOT_FOUND");
        };
        let Some(source) = self.first_parents(tip).get(back).copied() else {
            return Outcome::Refused("NOT_FOUND");
        };
        let Some(&parent) = self.commits[source].parents.first() else {
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
    pub(crate) fn record(
        &mut self,
        branch: &str,
        parent: CommitId,
        tree: Tree,
        read_set: BTreeSet<String>,
        writes: BTreeSet<String>,
    ) -> Outcome {
        let id = self.commits.len();
        self.commits.push(Commit {
            parents: vec![parent],
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
}
