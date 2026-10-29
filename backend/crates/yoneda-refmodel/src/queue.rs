//! Queued landings on main: a landing is queued as a numbered ticket, and the combiner
//! settles the queue in batches. A batch whose first landable item fast-forwards lands it
//! alone; otherwise every item is merged against the head on its own, and those that merge
//! cleanly without touching what an earlier member of the batch read or wrote land
//! together as one octopus merge commit (one log entry); the others wait for the next
//! batch. Items main can no longer take (a stale read or parent) and merge conflicts fail.
use crate::land::Occ;
use crate::merge::merge3;
use crate::{Commit, CommitId, MAIN, Outcome, Repo};
use std::collections::BTreeSet;

/// Most tickets one batch takes.
const BATCH: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TicketStatus {
    Pending,
    Landed,
    Failed(&'static str),
}

#[derive(Clone, Debug)]
pub struct Ticket {
    /// Numbered from 1 in queue order.
    pub id: u64,
    pub commit: CommitId,
    pub status: TicketStatus,
}

/// What one combiner run settled: tickets landed, tickets failed (with why), and the merge
/// commit it landed, if any.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Batch {
    pub landed: Vec<u64>,
    pub failed: Vec<(u64, &'static str)>,
    pub merge: Option<CommitId>,
}

/// A pending ticket's place in the batch.
struct Item {
    ticket: usize,
    commit: CommitId,
    base: Option<CommitId>,
    keys: BTreeSet<String>,
    writes: BTreeSet<String>,
}

impl Repo {
    /// Whether landings wait in `refname`'s queue (only main's is used).
    pub(crate) fn busy(&self, refname: &str) -> bool {
        refname == MAIN
            && self
                .tickets
                .iter()
                .any(|t| t.status == TicketStatus::Pending)
    }

    /// Lands `branch`'s tip on main, or, where that needs a merge, queues it (`repo_land`
    /// with `enqueue`); a commit already pending keeps its ticket.
    pub(crate) fn enqueue(&mut self, branch: &str) -> Outcome {
        let Some(commit) = self.tip(branch) else {
            return Outcome::Refused("NOT_FOUND");
        };
        match self.land(commit) {
            Outcome::Refused("MERGE_REQUIRED") => {}
            other => return other,
        }
        let pending = self
            .tickets
            .iter()
            .find(|t| t.commit == commit && t.status == TicketStatus::Pending);
        if let Some(ticket) = pending {
            return Outcome::Queued(ticket.id);
        }
        let id = self.tickets.len() as u64 + 1;
        self.tickets.push(Ticket {
            id,
            commit,
            status: TicketStatus::Pending,
        });
        Outcome::Queued(id)
    }

    fn settle(&mut self, ticket: usize, status: TicketStatus, batch: &mut Batch) {
        match status {
            TicketStatus::Landed => batch.landed.push(self.tickets[ticket].id),
            TicketStatus::Failed(code) => batch.failed.push((self.tickets[ticket].id, code)),
            TicketStatus::Pending => {}
        }
        self.tickets[ticket].status = status;
    }

    /// One combiner run over main's queue.
    pub(crate) fn run_queue(&mut self) -> Outcome {
        let mut batch = Batch::default();
        let Some(head) = self.tip(MAIN) else {
            return Outcome::Refused("NOT_FOUND");
        };
        let pending: Vec<usize> = (0..self.tickets.len())
            .filter(|t| self.tickets[*t].status == TicketStatus::Pending)
            .take(BATCH)
            .collect();
        let (mut fast, mut items) = (None, Vec::new());
        for ticket in pending {
            let commit = self.tickets[ticket].commit;
            let c = &self.commits[commit];
            // On the head: its parent, or the head is (or is below) it.
            if c.parents.first() == Some(&head) || self.ancestors(commit).contains(&head) {
                fast = fast.or(Some(ticket));
                continue;
            }
            match self.occ(commit, MAIN) {
                Occ::Conflict(_) => {
                    self.settle(ticket, TicketStatus::Failed("CONFLICT"), &mut batch)
                }
                Occ::FastForward => {
                    self.settle(ticket, TicketStatus::Failed("STALE_PARENT"), &mut batch)
                }
                Occ::Rebase | Occ::Merge(_) => {
                    let writes = self.branch_paths(commit, head);
                    items.push(Item {
                        ticket,
                        commit,
                        base: self.merge_bases(head, commit).into_iter().next(),
                        keys: c.read_set.iter().chain(&writes).cloned().collect(),
                        writes,
                    });
                }
            }
        }
        if let Some(ticket) = fast {
            let commit = self.tickets[ticket].commit;
            let paths = Self::changed(&self.commits[head].tree, &self.commits[commit].tree);
            self.move_ref(MAIN, Some(commit), paths, true);
            self.landings.insert((commit, MAIN.to_owned()));
            self.settle(ticket, TicketStatus::Landed, &mut batch);
            return Outcome::Batch(batch);
        }
        self.octopus(head, items, batch)
    }

    /// Merges each item against `head` and lands the clean, independent ones as one merge.
    fn octopus(&mut self, head: CommitId, items: Vec<Item>, mut batch: Batch) -> Outcome {
        let ours = self.commits[head].tree.clone();
        let (mut tree, mut accepted) = (ours.clone(), Vec::new());
        let (mut written, mut touched) = (BTreeSet::new(), BTreeSet::new());
        for item in items {
            let theirs = &self.commits[item.commit].tree;
            let Some(merged) = merge3(&self.tree_of(item.base), &ours, theirs) else {
                self.settle(item.ticket, TicketStatus::Failed("CONFLICT"), &mut batch);
                continue;
            };
            let changed = Self::changed(&ours, &merged);
            // Write skew or a path an earlier member merged: the next batch takes it.
            if item.keys.iter().any(|k| written.contains(k)) || !changed.is_disjoint(&touched) {
                continue;
            }
            for path in &changed {
                match merged.get(path) {
                    Some(text) => tree.insert(path.clone(), text.clone()),
                    None => tree.remove(path),
                };
            }
            written.extend(item.writes);
            touched.extend(changed);
            accepted.push((item.ticket, item.commit));
        }
        if accepted.is_empty() {
            return Outcome::Batch(batch);
        }
        let writes = Self::changed(&ours, &tree);
        if !writes.is_subset(&written) {
            return Outcome::Refused("FORBIDDEN");
        }
        let id = self.commits.len();
        self.commits.push(Commit {
            parents: std::iter::once(head)
                .chain(accepted.iter().map(|a| a.1))
                .collect(),
            tree,
            base_version: self.version,
            read_set: BTreeSet::new(),
            writes: writes.clone(),
        });
        self.move_ref(MAIN, Some(id), writes, true);
        self.landings.insert((id, MAIN.to_owned()));
        for (ticket, commit) in accepted {
            self.landings.insert((commit, MAIN.to_owned()));
            self.settle(ticket, TicketStatus::Landed, &mut batch);
        }
        batch.merge = Some(id);
        Outcome::Batch(batch)
    }
}
