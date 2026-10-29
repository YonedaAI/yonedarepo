//! Working branches and tags: compare-and-swap moves and deletions, and tags created once.
use crate::{CommitId, Outcome, Repo};
use std::collections::BTreeSet;

impl Repo {
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
    pub(crate) fn delete(&mut self, name: &str, expected: Option<CommitId>) -> Outcome {
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
    pub(crate) fn tag(&mut self, name: &str, target: CommitId, message: Option<&str>) -> Outcome {
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
}
