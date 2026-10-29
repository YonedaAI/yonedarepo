//! Platform merge commits and rebases, built as the adapter builds them: a three-way merge
//! of whole trees, decided per file (files are one line, so two different changes to a file
//! always conflict).
use crate::{Commit, CommitId, MAIN, Outcome, Repo, Tree};
use std::collections::BTreeSet;

/// `theirs` merged into `ours` from `base`; `None` where a file conflicts.
pub fn merge3(base: &Tree, ours: &Tree, theirs: &Tree) -> Option<Tree> {
    let mut merged = ours.clone();
    let paths: BTreeSet<&String> = base
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .collect();
    for path in paths {
        let (b, o, t) = (base.get(path), ours.get(path), theirs.get(path));
        if o == t || t == b {
            continue;
        }
        if o != b {
            return None;
        }
        match t {
            Some(text) => merged.insert(path.clone(), text.clone()),
            None => merged.remove(path),
        };
    }
    Some(merged)
}

impl Repo {
    /// Paths written by the commits reachable from `tip` and not from `head`.
    pub(crate) fn branch_paths(&self, tip: CommitId, head: CommitId) -> BTreeSet<String> {
        let behind = self.ancestors(head);
        self.ancestors(tip)
            .into_iter()
            .filter(|c| !behind.contains(c))
            .flat_map(|c| self.commits[c].writes.iter().cloned())
            .collect()
    }

    pub(crate) fn tree_of(&self, commit: Option<CommitId>) -> Tree {
        commit
            .map(|c| self.commits[c].tree.clone())
            .unwrap_or_default()
    }

    /// Lands `commit` on main; where that needs a merge, merges it into main's head from
    /// their merge base and lands the merge commit (parents: the head, then `commit`) in
    /// one log entry recording both as landed. The merge may change only paths the merged
    /// work wrote (commits reachable from it and not from the head).
    pub(crate) fn merge_land(&mut self, commit: CommitId) -> Outcome {
        match self.land(commit) {
            Outcome::Refused("MERGE_REQUIRED") => {}
            other => return other,
        }
        // Building the merge reads main's plan, refused until the projector caught up.
        if !self.unprojected.is_empty() {
            return Outcome::Refused("PROJECTION_PENDING");
        }
        let Some(head) = self.tip(MAIN) else {
            return Outcome::Refused("NOT_FOUND");
        };
        let base = self.merge_bases(head, commit).into_iter().next();
        let ours = &self.commits[head].tree;
        let Some(tree) = merge3(&self.tree_of(base), ours, &self.commits[commit].tree) else {
            return Outcome::Refused("CONFLICT");
        };
        // The merge commit is built, but queued landings refuse it as they refuse any.
        if self.busy(MAIN) {
            return Outcome::Refused("MERGE_REQUIRED");
        }
        let writes = Self::changed(ours, &tree);
        let allowed = self.branch_paths(commit, head);
        if writes.iter().any(|path| !allowed.contains(path)) {
            return Outcome::Refused("FORBIDDEN");
        }
        let id = self.commits.len();
        self.commits.push(Commit {
            parents: vec![head, commit],
            tree,
            base_version: self.version,
            read_set: BTreeSet::new(),
            writes: writes.clone(),
        });
        self.move_ref(MAIN, Some(id), writes, true);
        self.landed(id, MAIN.to_owned());
        self.landed(commit, MAIN.to_owned());
        Outcome::Committed(id)
    }

    /// `git rebase main <branch>` on the server: the branch's first-parent commits not in
    /// main are merged one by one onto main's head (each onto the last), those that change
    /// nothing are dropped, and the branch moves to the result by compare-and-swap. Any
    /// conflict refuses the whole rebase and moves nothing.
    pub(crate) fn rebase(&mut self, branch: &str) -> Outcome {
        if Self::protected(branch) {
            return Outcome::Refused("FORBIDDEN");
        }
        // The plan reads the refs, refused until the projector caught up.
        if !self.unprojected.is_empty() {
            return Outcome::Refused("PROJECTION_PENDING");
        }
        let (Some(head), Some(onto)) = (self.tip(branch), self.tip(MAIN)) else {
            return Outcome::Refused("NOT_FOUND");
        };
        // Up to date when the branch already holds main's head; a branch behind main has
        // nothing to replay and fast-forwards to it.
        if self.ancestors(head).contains(&onto) {
            return Outcome::Already;
        }
        let below = self.ancestors(onto);
        let mut replayed = Vec::new();
        for id in self.first_parents(head) {
            if below.contains(&id) {
                break;
            }
            if self.commits[id].parents.len() > 1 {
                return Outcome::Refused("NOT_SUPPORTED");
            }
            replayed.push(id);
        }
        replayed.reverse();
        // Merge all first: a conflict anywhere leaves the model untouched.
        let mut trees: Vec<Tree> = Vec::new();
        let mut current = self.commits[onto].tree.clone();
        for id in &replayed {
            let base = self.tree_of(self.commits[*id].parents.first().copied());
            let Some(merged) = merge3(&base, &current, &self.commits[*id].tree) else {
                return Outcome::Refused("CONFLICT");
            };
            if merged != current {
                trees.push(merged.clone());
                current = merged;
            }
        }
        let (version, mut parent, mut made) = (self.version, onto, Vec::new());
        for tree in trees {
            let id = self.commits.len();
            self.commits.push(Commit {
                parents: vec![parent],
                writes: Self::changed(&self.commits[parent].tree, &tree),
                tree,
                base_version: version,
                read_set: BTreeSet::new(),
            });
            made.push(id);
            parent = id;
        }
        match self.set(branch, parent, Some(head)) {
            Outcome::Moved => Outcome::Rebased(made),
            other => other,
        }
    }
}
