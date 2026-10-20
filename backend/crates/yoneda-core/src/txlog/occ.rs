//! Optimistic concurrency at landing (backward validation). Entries that landed after a
//! change's base are serialized before it, so the only stale dependency is a path the
//! change *read* that they *wrote*: that is a conflict to reconcile. Reads may name
//! symbols (`path#symbol`); a later write then conflicts only if the platform derived
//! that it touched the symbol, and any write it could not resolve counts as the whole
//! file. Writes to the same file are a lost-update risk resolved by a three-way merge;
//! disjoint writes rebase.
//! The paper's Eq. 1 (writes meet neither reads nor writes, both ways) governs which
//! changes may *run* in parallel; it is enforced by the scheduler, not here. Path
//! disjointness is necessary, not sufficient, for semantic independence: landed merges
//! still run a combined acceptance stage.
use super::{AccessSet, SymbolTouch, TxEntry};
use crate::git_object::ObjectId;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proposal {
    pub refname: String,
    pub base_version: u64,
    /// The ref value the writer saw at `base_version`.
    pub expected_old: Option<ObjectId>,
    pub write_set: BTreeSet<String>,
    /// Paths, `dir/` prefixes or `path#symbol` entries.
    pub read_set: BTreeSet<String>,
}

/// Symbol refinements of later entries' writes, by log version.
pub type Refinements = BTreeMap<u64, Vec<SymbolTouch>>;

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

/// The first entry on `refname` that wrote something `reads` covers (or moved the ref
/// opaquely), with the read entries it invalidated.
pub fn stale_read(
    reads: &AccessSet,
    refname: &str,
    later: &[TxEntry],
    refined: &Refinements,
) -> Option<(u64, Vec<String>)> {
    later
        .iter()
        .filter(|e| e.refname == refname)
        .find_map(|entry| {
            let paths = entry.paths.iter().map(|p| p.path.as_str());
            let theirs = AccessSet::writes(paths, refined.get(&entry.version).map_or(&[], |r| r));
            // Ref moves without path detail (reset, delete) cannot be proven independent.
            let opaque = entry.paths.is_empty()
                && !matches!(
                    entry.kind,
                    super::TxKind::Commit | super::TxKind::Merge | super::TxKind::Changeset
                );
            let stale = reads.meeting(&theirs);
            (opaque || !stale.is_empty()).then_some((entry.version, stale))
        })
}

impl Proposal {
    /// `later` holds every log entry with `version > base_version`, in order; `refined`
    /// narrows their writes to the symbols the platform derived.
    pub fn check(&self, later: &[TxEntry], refined: &Refinements) -> OccOutcome {
        let reads = AccessSet::parse(&self.read_set);
        if let Some((version, paths)) = stale_read(&reads, &self.refname, later, refined) {
            return OccOutcome::Conflict { version, paths };
        }
        let mut concurrent = Vec::new();
        let mut shared: Vec<String> = Vec::new();
        for entry in later.iter().filter(|e| e.refname == self.refname) {
            let their_writes: Vec<&str> = entry.paths.iter().map(|p| p.path.as_str()).collect();
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
