//! Delta-style transaction log for a repository: an append-only, hash-chained sequence of
//! ref transitions with the paths each one touched. Snapshots are `(version → refs)`;
//! writers commit optimistically and are checked against entries after their base version.
mod access;
mod checkpoint;
mod entry;
mod occ;
mod plan;
mod scc;

pub use access::{Access, AccessSet, SymbolTouch, independent, symbols_overlap};
pub use checkpoint::{Checkpoint, replay, replay_projected};
pub use entry::{PathOp, PathTouch, TxEntry, TxKind, chain_digest};
pub use occ::{OccOutcome, Proposal, Refinements, overlaps, stale_read};
pub use plan::{Plan, PlannedItem, SymbolGraph, SymbolNode, WorkItem, plan};
pub use scc::tarjan;

pub(crate) fn invalid(message: impl Into<String>) -> crate::Error {
    crate::Error::new("TXLOG_INVALID", message)
}

#[cfg(test)]
mod tests;
