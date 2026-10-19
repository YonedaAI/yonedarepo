//! Optimistic concurrency at landing (backward validation). Entries that landed after a
//! change's base are serialized before it, so the only stale dependency is a path the
//! change *read* that they *wrote*: that is a conflict to reconcile. Writes to the same
//! file are a lost-update risk resolved by a three-way merge; disjoint writes rebase.
//! The paper's Eq. 1 (writes meet neither reads nor writes, both ways) governs which
//! changes may *run* in parallel; it is enforced by the scheduler, not here. Path
//! disjointness is necessary, not sufficient, for semantic independence: landed merges
//! still run a combined acceptance stage.
use super::TxEntry;
use crate::git_object::ObjectId;
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proposal {
    pub refname: String,
    pub base_version: u64,
    /// The ref value the writer saw at `base_version`.
    pub expected_old: Option<ObjectId>,
    pub write_set: BTreeSet<String>,
    pub read_set: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OccOutcome {
    /// Nothing moved the ref since the base: compare-and-swap directly.
    FastForward,
    /// The ref moved, but only through entries writing other paths: merge commit, then
    /// combined checks.
    Rebase { concurrent: Vec<u64> },
    /// Later entries wrote some of the same files (and nothing this change read): try a
    /// three-way content merge.
    Merge {
        concurrent: Vec<u64>,
        paths: Vec<String>,
    },
    /// A later entry wrote what this change read (or moved the ref opaquely).
    Conflict { version: u64, paths: Vec<String> },
}

/// `a` and `b` overlap when equal or when one is a `dir/` prefix of the other.
pub fn overlaps(a: &str, b: &str) -> bool {
    let within = |inner: &str, outer: &str| {
        outer.ends_with('/') && inner.starts_with(outer)
            || inner.len() > outer.len()
                && inner.starts_with(outer)
                && inner.as_bytes()[outer.len()] == b'/'
    };
    a == b || within(a, b) || within(b, a)
}

fn meeting(left: &BTreeSet<String>, right: &[&str]) -> Vec<String> {
    left.iter()
        .filter(|l| right.iter().any(|r| overlaps(l, r)))
        .cloned()
        .collect()
}

impl Proposal {
    /// `later` holds every log entry with `version > base_version`, in order.
    pub fn check(&self, later: &[TxEntry]) -> OccOutcome {
        let mut concurrent = Vec::new();
        let mut shared: Vec<String> = Vec::new();
        for entry in later.iter().filter(|e| e.refname == self.refname) {
            let their_writes: Vec<&str> = entry.paths.iter().map(|p| p.path.as_str()).collect();
            let mut stale = meeting(&self.read_set, &their_writes);
            // Ref moves without path detail (reset, delete) cannot be proven independent.
            let opaque = their_writes.is_empty()
                && !matches!(entry.kind, super::TxKind::Commit | super::TxKind::Merge);
            if opaque || !stale.is_empty() {
                stale.sort();
                stale.dedup();
                return OccOutcome::Conflict {
                    version: entry.version,
                    paths: stale,
                };
            }
            shared.extend(meeting(&self.write_set, &their_writes));
            concurrent.push(entry.version);
        }
        shared.sort();
        shared.dedup();
        match (concurrent.is_empty(), shared.is_empty()) {
            (true, _) => OccOutcome::FastForward,
            (false, true) => OccOutcome::Rebase { concurrent },
            (false, false) => OccOutcome::Merge {
                concurrent,
                paths: shared,
            },
        }
    }
}
