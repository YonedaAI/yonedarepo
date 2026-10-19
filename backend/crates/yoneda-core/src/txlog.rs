//! Delta-style transaction log for a repository: an append-only, hash-chained sequence of
//! ref transitions with the paths each one touched. Snapshots are `(version → refs)`;
//! writers commit optimistically and are checked against entries after their base version.
mod checkpoint;
mod entry;
mod occ;

pub use checkpoint::{Checkpoint, replay};
pub use entry::{PathOp, PathTouch, TxEntry, TxKind, chain_digest};
pub use occ::{OccOutcome, Proposal, overlaps};

pub(crate) fn invalid(message: impl Into<String>) -> crate::Error {
    crate::Error::new("TXLOG_INVALID", message)
}

#[cfg(test)]
mod tests;
