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
    /// Commits projection made, oldest first (none when not projected, or where a landed
    /// commit itself became main's head).
    pub projected: Vec<CommitId>,
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
    /// Built on shard commits the authority does not hold: send the chain.
    NeedChain,
    Failed(&'static str),
}

impl Repo {
    /// `repo_head`: the last projected head, as of the version before the first changeset
    /// not projected yet (work based there is checked against them when it lands).
    pub(crate) fn publish(&mut self) -> Outcome {
        if let Some(head) = self.tip(MAIN) {
            let first = self.unprojected.first().and_then(|batch| batch.first());
            self.published = (head, first.map_or(self.version, |(v, _)| v - 1));
        }
        Outcome::Done
    }

    /// A commit begun from the published head, on it or (`on`) on an earlier shard commit.
    pub(crate) fn shard_commit(
        &mut self,
        path: &str,
        content: &str,
        read: bool,
        on: Option<usize>,
    ) -> Outcome {
        let (head, base_version) = self.published;
        let parent = match on {
            Some(index) => match self.shard.get(index) {
                Some(commit) => *commit,
                None => return Outcome::Refused("NOT_FOUND"),
            },
            None => head,
        };
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
        self.unrecorded.insert(id);
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

    /// The combiner submits `picks` (each with its chain of shard commits the authority
    /// lacks when `chained`), then, with `project`, the projector runs.
    pub(crate) fn submit(&mut self, picks: &[usize], chained: bool, project: bool) -> Outcome {
        let mut submitted = Submitted::default();
        let (mut written, mut landed) = (BTreeSet::new(), Vec::new());
        let commits: Vec<CommitId> = picks
            .iter()
            .filter_map(|p| self.shard.get(*p).copied())
            .collect();
        for commit in commits {
            let item = self.submit_one(commit, chained, &mut written, &mut landed);
            submitted.items.push(item);
        }
        if !landed.is_empty() {
            self.unprojected.push(landed);
        }
        if project {
            submitted.projected = self.project();
        }
        Outcome::Submitted(submitted)
    }

    /// `commit` after the shard commits below it that the authority lacks, oldest first.
    fn chain(&self, commit: CommitId) -> Vec<CommitId> {
        let mut chain = vec![commit];
        while let Some(parent) = chain
            .last()
            .and_then(|c| self.commits[*c].parents.first())
            .filter(|p| self.unrecorded.contains(p))
        {
            chain.push(*parent);
        }
        chain.reverse();
        chain
    }

    fn submit_one(
        &mut self,
        commit: CommitId,
        chained: bool,
        written: &mut BTreeSet<String>,
        landed: &mut Vec<(u64, CommitId)>,
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
            // The merge path adopts the records sent: the first's parents must be held.
            let records = if chained {
                self.chain(commit)
            } else {
                vec![commit]
            };
            let first = &self.commits[records[0]];
            if first.parents.iter().any(|p| self.unrecorded.contains(p)) {
                return Item::NeedChain;
            }
            for record in &records {
                self.unrecorded.remove(record);
            }
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
        landed.push((self.version, commit));
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

    /// The projector: main's Git commit for each submission's changesets, in order. A
    /// submission whose only changeset is a commit on the head makes it the head; any
    /// other gets a commit whose parents are the head and its landed commits, based at the
    /// version before its first changeset. The landed commits are recorded then.
    pub(crate) fn project(&mut self) -> Vec<CommitId> {
        let mut made = Vec::new();
        for batch in std::mem::take(&mut self.unprojected) {
            let Some(head) = self.tip(MAIN) else {
                break;
            };
            let landed: Vec<CommitId> = batch.iter().map(|(_, c)| *c).collect();
            let target = match landed.as_slice() {
                [only] if self.commits[*only].parents == [head] => *only,
                _ => {
                    let mut tree = self.commits[head].tree.clone();
                    for commit in &landed {
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
                        base_version: batch[0].0 - 1,
                        read_set: BTreeSet::new(),
                        writes,
                    });
                    made.push(id);
                    id
                }
            };
            for entry in self
                .log
                .iter_mut()
                .filter(|e| batch.iter().any(|(v, _)| *v == e.version))
            {
                entry.head = Some(target);
            }
            for commit in &landed {
                self.unrecorded.remove(commit);
            }
            self.refs.insert(MAIN.to_owned(), target);
        }
        made
    }
}
