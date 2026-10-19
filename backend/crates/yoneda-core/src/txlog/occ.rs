//! Optimistic concurrency at landing. Independence follows the owner's paper (Eq. 1):
//! two changes may both land only if neither's writes meet the other's reads or writes.
//! Path disjointness is necessary, not sufficient, for semantic independence; landed
//! merges still run a combined acceptance stage.
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
    /// The ref moved, but only through independent entries: merge, then run combined checks.
    Rebase { concurrent: Vec<u64> },
    /// A later entry wrote what this change reads or writes, or read what it writes.
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
        for entry in later.iter().filter(|e| e.refname == self.refname) {
            let their_writes: Vec<&str> = entry.paths.iter().map(|p| p.path.as_str()).collect();
            let their_reads: Vec<&str> = entry.read_set.iter().map(String::as_str).collect();
            let mut paths = meeting(&self.write_set, &their_writes);
            paths.extend(meeting(&self.write_set, &their_reads));
            paths.extend(meeting(&self.read_set, &their_writes));
            // Ref moves without path detail (reset, delete) cannot be proven independent.
            let opaque = their_writes.is_empty() && entry.kind != super::TxKind::Commit;
            if opaque || !paths.is_empty() {
                paths.sort();
                paths.dedup();
                return OccOutcome::Conflict {
                    version: entry.version,
                    paths,
                };
            }
            concurrent.push(entry.version);
        }
        if concurrent.is_empty() {
            OccOutcome::FastForward
        } else {
            OccOutcome::Rebase { concurrent }
        }
    }
}
