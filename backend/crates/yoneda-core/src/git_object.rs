//! Byte-exact Git object model (SHA-1) for server-side commits.
//!
//! YonedaRepo builds blobs, trees and commits itself and stores them in Artifacts, so
//! object ids must match what `git` computes. Decoding is lossless: re-encoding a
//! decoded object reproduces its original bytes and id.
mod commit;
mod delta;
mod diff;
mod graph;
mod id;
mod pack;
mod pack_header;
mod pack_reader;
mod pack_walk;
mod protocol;
mod protocol_v2;
mod push_batch;
mod rewrite;
mod smart_http;
mod tree;

pub use commit::{Commit, Signature};
pub use delta::{apply_delta, delta_result_size};
pub use diff::{TreeChange, Walk, diff_trees};
pub use graph::{CommitGraph, is_ancestor, merge_bases, next_generation};
pub use id::{ObjectId, ObjectKind, hash_object};
pub use pack::{PackLimits, PackWriter, read_pack, write_pack};
pub use pack_reader::PackReader;
pub use protocol::{
    HIDDEN_REF_PREFIX, ReceivedPush, hidden_ref, parse_receive_pack_request, receive_pack_delete,
    receive_pack_outcome, receive_pack_report, receive_pack_request, verify_receive_pack_report,
};
pub use protocol_v2::{
    DELIM, FetchArgs, FetchHead, INFINITE_DEPTH, LsRefs, V2Command, ls_refs_answer,
    v2_capabilities, v2_request,
};
pub use push_batch::{combine_receive_pack_requests, split_receive_pack_report};
pub use rewrite::{PathChange, Rewrite, TreeSource, rewrite_tree};
pub use smart_http::{
    CommandList, FLUSH, Packet, RefCommand, UploadRequest, advertisement, command_list, next_pkt,
    pkt_line, report_status, side_band, upload_request, valid_ref_name,
};
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
