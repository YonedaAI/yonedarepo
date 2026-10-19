//! Byte-exact Git object model (SHA-1) for server-side commits.
//!
//! YonedaRepo builds blobs, trees and commits itself and stores them in Artifacts, so
//! object ids must match what `git` computes. Decoding is lossless: re-encoding a
//! decoded object reproduces its original bytes and id.
mod commit;
mod graph;
mod id;
mod pack;
mod rewrite;
mod tree;

pub use commit::{Commit, Signature};
pub use graph::{CommitGraph, is_ancestor, merge_bases, next_generation};
pub use id::{ObjectId, ObjectKind, hash_object};
pub use pack::{PackLimits, read_pack, write_pack};
pub use rewrite::{PathChange, Rewrite, TreeSource, rewrite_tree};
pub use tree::{FileMode, MAX_TREE_ENTRIES, TreeEntry, decode_tree, encode_tree};

pub(crate) fn invalid(message: impl Into<String>) -> crate::Error {
    crate::Error::new("GIT_OBJECT_INVALID", message)
}

#[cfg(test)]
mod tests;
