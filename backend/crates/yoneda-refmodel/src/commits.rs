//! New commits on a branch's tip, landed there: a one-file change, or a revert.
use crate::{Commit, CommitId, Outcome, Repo, Tree};
use std::collections::BTreeSet;

impl Repo {
    /// Why a one-file change to `branch`'s tip would be refused before it is recorded.
    pub(crate) fn change_refusal(
        &self,
        branch: &str,
        path: &str,
        content: Option<&str>,
    ) -> Option<&'static str> {
        let Some(parent) = self.tip(branch) else {
            return Some("NOT_FOUND");
        };
        let tree = &self.commits[parent].tree;
        match content {
            Some(text) if tree.get(path).map(String::as_str) == Some(text) => Some("NO_CHANGES"),
            None if !tree.contains_key(path) => Some("NOT_FOUND"),
            _ => None,
        }
    }

    pub(crate) fn commit(
        &mut self,
        branch: &str,
        path: &str,
        content: Option<&str>,
        read: bool,
    ) -> Outcome {
        if let Some(code) = self.change_refusal(branch, path, content) {
            return Outcome::Refused(code);
        }
        let Some(parent) = self.tip(branch) else {
            return Outcome::Refused("NOT_FOUND");
        };
        let mut tree = self.commits[parent].tree.clone();
        match content {
            Some(text) => tree.insert(path.to_owned(), text.to_owned()),
            None => tree.remove(path),
        };
        let reads = if read {
            BTreeSet::from([path.to_owned()])
        } else {
            BTreeSet::new()
        };
        let writes = BTreeSet::from([path.to_owned()]);
        self.record(branch, parent, tree, reads, writes)
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
        // A commit that changed nothing (a merge that brought nothing new) gives a revert no
        // change to commit; the platform refuses an empty change list.
        if changed.is_empty() {
            return Outcome::Refused("INVALID_INPUT");
        }
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
        // Built on the branch's tip, it fast-forwards there unless queued landings hold
        // the branch; refused, it is left unlanded (and unnumbered here: nothing names it).
        match self.land_on(branch, id) {
            Outcome::Moved => Outcome::Committed(id),
            other => {
                self.commits.pop();
                other
            }
        }
    }
}
