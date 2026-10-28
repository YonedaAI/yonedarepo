//! Git wire transport codecs: pkt-line framing, smart HTTP (v0 stateless RPC), protocol
//! v2 upload-pack, and the receive-pack bodies the platform sends to and reads back from
//! the object store.
//!
//! Everything here is pure encoding and parsing over byte slices built on the object model
//! in [`crate::git_object`]; no I/O and no policy. Which refs a client may see or update
//! and which objects a fetch sends are decided by the platform.
mod protocol;
mod protocol_v2;
mod push_batch;
mod smart_http;

pub use protocol::{
    ReceivedPush, hidden_ref, parse_receive_pack_request, receive_pack_delete,
    receive_pack_outcome, receive_pack_report, receive_pack_request, verify_receive_pack_report,
};
pub use protocol_v2::{
    DELIM, FetchArgs, FetchHead, INFINITE_DEPTH, LsRefs, V2Command, ls_refs_answer,
    v2_capabilities, v2_request,
};
pub use push_batch::{combine_receive_pack_requests, split_receive_pack_report};
pub use smart_http::{
    CommandList, FLUSH, RefCommand, UploadRequest, advertisement, command_list, pkt_line,
    report_status, side_band, upload_request,
};
