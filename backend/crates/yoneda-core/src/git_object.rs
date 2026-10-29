//! Byte-exact Git object model (SHA-1) for server-side commits.
//!
//! YonedaRepo builds blobs, trees and commits itself and stores them in Artifacts, so
//! object ids must match what `git` computes. Decoding is lossless: re-encoding a
//! decoded object reproduces its original bytes and id.
mod commit;
mod delta;
mod delta_encode;
mod diff;
mod graph;
mod id;
mod pack;
mod pack_header;
mod pack_reader;
mod pack_walk;
mod rewrite;
mod signature;
mod tag;
mod tree;

pub use commit::{Commit, CommitHeader};
pub use delta::{apply_delta, delta_result_size};
pub use delta_encode::encode_delta;
pub use diff::{TreeChange, TreeLookup, Walk, diff_trees, diff_trees_in};
pub use graph::{CommitGraph, is_ancestor, merge_bases, next_generation};
pub use id::{ObjectHasher, ObjectId, ObjectKind, hash_object};
pub use pack::{PackLimits, PackWriter, read_pack, write_pack};
pub use pack_reader::PackReader;
pub use pack_walk::Spill;
pub use rewrite::{PathChange, Rewrite, TreeSource, rewrite_tree};
pub use signature::{Signature, TzOffset};
pub use tag::{AnnotatedTag, MAX_TAG_BYTES};
pub use tree::{FileMode, MAX_TREE_ENTRIES, TreeEntry, decode_tree, encode_tree};

pub(crate) fn invalid(message: impl Into<String>) -> crate::Error {
    crate::Error::new("GIT_OBJECT_INVALID", message)
}

#[cfg(test)]
mod pack_git_tests;
#[cfg(test)]
mod proptests;
#[cfg(test)]
mod tests;
