//! Shard commits and submitted landings. A client begins from main's published head (a
//! cached copy that may trail the log), builds its commit without the authority, and the
//! branch's combiner submits it. The authority routes each submission against everything
//! landed on main since the published version: untouched paths land as a changeset (a log
//! entry and no Git commit yet); a later write to a path it writes takes the merge path
//! (adopted and queued); a later write to a path it read is a conflict. A member that
//! reads or writes what an earlier member of the same submission wrote waits (deferred).
//! The projector then builds main's Git commit for the submission: the landed commit
//! itself where it is the only one and sits on the head, else a commit whose parents are
//! the head and every landed commit.
use crate::land::Occ;
use crate::queue::{Ticket, TicketStatus};
use crate::{Commit, CommitId, Entry, MAIN, Outcome, Repo};
use std::collections::BTreeSet;

/// What a submission answered, member by member, and the commit projection built for it
/// (`None` where nothing landed or the landed commit itself became main's head).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Submitted {
    pub items: Vec<Item>,
    pub projected: Option<CommitId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Item {
    /// Landed as a changeset at this version.
    Landed(u64),
    /// Landed before, at this version.
    Already(u64),
    /// Reads or writes what an earlier member wrote: a later submission takes it.
    Deferred,
    /// On the merge path, as this ticket.
    Queued(u64),
    Failed(&'static str),
}

impl Repo {
    pub(crate) fn publish(&mut self) -> Outcome {
        if let Some(head) = self.tip(MAIN) {
            self.published = (head, self.version);
        }
        Outcome::Done
    }

    pub(crate) fn shard_commit(&mut self, path: &str, content: &str, read: bool) -> Outcome {
        let (parent, base_version) = self.published;
        let mut tree = self.commits[parent].tree.clone();
        if tree.get(path).map(String::as_str) == Some(content) {
            return Outcome::Refused("NO_CHANGES");
        }
        tree.insert(path.to_owned(), content.to_owned());
        let id = self.commits.len();
        let read_set = if read {
            BTreeSet::from([path.to_owned()])
        } else {
            BTreeSet::new()
        };
        self.commits.push(Commit {
            parents: vec![parent],
            tree,
            base_version,
            read_set,
            writes: BTreeSet::from([path.to_owned()]),
        });
        self.shard.push(id);
        Outcome::Committed(id)
    }

    /// Main's commit as of `version`: after its last entry at or before it.
    fn head_at(&self, version: u64) -> Option<CommitId> {
        self.log
            .iter()
            .rev()
            .find(|e| e.refname == MAIN && e.version <= version)
            .and_then(|e| e.head)
    }

    /// Whether an entry on main after `base` wrote one of `keys`, or moved main without
    /// paths (as a reset would).
    fn touched_since(&self, base: u64, keys: &BTreeSet<String>) -> bool {
        self.log.iter().any(|e| {
            e.refname == MAIN
                && e.version > base
                && (e.paths.is_empty() && !e.landing || e.paths.iter().any(|p| keys.contains(p)))
        })
    }

    pub(crate) fn submit(&mut self, picks: &[usize]) -> Outcome {
        let mut submitted = Submitted::default();
        let (mut written, mut landed) = (BTreeSet::new(), Vec::new());
        let commits: Vec<CommitId> = picks
            .iter()
            .filter_map(|p| self.shard.get(*p).copied())
            .collect();
        for commit in commits {
            let item = self.submit_one(commit, &mut written, &mut landed);
            submitted.items.push(item);
        }
        submitted.projected = self.project(&landed);
        Outcome::Submitted(submitted)
    }

    fn submit_one(
        &mut self,
        commit: CommitId,
        written: &mut BTreeSet<String>,
        landed: &mut Vec<CommitId>,
    ) -> Item {
        if let Some(version) = self.landings.get(&(commit, MAIN.to_owned())) {
            return Item::Already(*version);
        }
        let c = &self.commits[commit];
        let (writes, base, parent) = (c.writes.clone(), c.base_version, c.parents.first().copied());
        let keys: BTreeSet<String> = c.read_set.iter().chain(&writes).cloned().collect();
        if keys.iter().any(|k| written.contains(k)) {
            return Item::Deferred;
        }
        let changeset = if self.head_at(base) != parent {
            false
        } else if !self.touched_since(base, &keys) {
            true
        } else {
            match self.occ(commit, MAIN) {
                Occ::Rebase => true,
                Occ::Merge(_) | Occ::FastForward => false,
                Occ::Conflict(_) => return Item::Failed("CONFLICT"),
            }
        };
        if !changeset {
            return Item::Queued(self.queue(commit));
        }
        self.version += 1;
        self.log.push(Entry {
            version: self.version,
            refname: MAIN.to_owned(),
            paths: writes.clone(),
            landing: true,
            head: None,
        });
        self.landed(commit, MAIN.to_owned());
        written.extend(writes);
        landed.push(commit);
        Item::Landed(self.version)
    }

    /// The pending ticket for `commit` on main, or a new one.
    fn queue(&mut self, commit: CommitId) -> u64 {
        let pending = self
            .tickets
            .iter()
            .find(|t| t.commit == commit && t.status == TicketStatus::Pending);
        if let Some(ticket) = pending {
            return ticket.id;
        }
        let id = self.tickets.len() as u64 + 1;
        self.tickets.push(Ticket {
            id,
            commit,
            status: TicketStatus::Pending,
        });
        id
    }

    /// Main's Git commit for the changesets `landed` by one submission; their log entries
    /// then name it.
    fn project(&mut self, landed: &[CommitId]) -> Option<CommitId> {
        let head = self.tip(MAIN)?;
        // The batch commit's base: the version before its first changeset.
        let base_version = self
            .log
            .iter()
            .find(|e| e.refname == MAIN && e.head.is_none())
            .map_or(self.version, |e| e.version - 1);
        let (target, made) = match landed {
            [] => return None,
            [only] if self.commits[*only].parents == [head] => (*only, None),
            _ => {
                let mut tree = self.commits[head].tree.clone();
                for commit in landed {
                    for path in &self.commits[*commit].writes {
                        match self.commits[*commit].tree.get(path) {
                            Some(text) => tree.insert(path.clone(), text.clone()),
                            None => tree.remove(path),
                        };
                    }
                }
                let id = self.commits.len();
                let writes = Self::changed(&self.commits[head].tree, &tree);
                self.commits.push(Commit {
                    parents: std::iter::once(head)
                        .chain(landed.iter().copied())
                        .collect(),
                    tree,
                    base_version,
                    read_set: BTreeSet::new(),
                    writes,
                });
                (id, Some(id))
            }
        };
        for entry in self
            .log
            .iter_mut()
            .filter(|e| e.refname == MAIN && e.head.is_none())
        {
            entry.head = Some(target);
        }
        self.refs.insert(MAIN.to_owned(), target);
        made
    }
}
