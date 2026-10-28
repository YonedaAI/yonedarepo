//! Receive-pack bodies and reports for the object store: ref-only updates, hidden-ref
//! releases, and the R2 store's side of a push.
use super::optional_id;
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Result,
    git_object::{ObjectId, hash_object},
};

/// A ref-only receive-pack request (empty pack) moving a branch from `old` (expected-old
/// lease; null to create) to `new`, which the object store already holds.
pub(super) fn ref_update(c: &Value) -> Result<Value> {
    use yoneda_core::{git_object::write_pack, transport::receive_pack_request};
    let refname = string(c, "refname")?;
    if !refname.starts_with("refs/heads/") {
        return Err(bad("Only branch refs are projected"));
    }
    let new = ObjectId::parse(&string(c, "new")?)?;
    let body = receive_pack_request(&refname, optional_id(c, "old")?, new, &write_pack(&[])?)?;
    Ok(json!({ "push_b64": STANDARD.encode(body) }))
}

/// Releases a commit's hidden ref (vacuum) so the object store may collect it.
pub(super) fn ref_delete(c: &Value) -> Result<Value> {
    let commit = ObjectId::parse(&string(c, "commit")?)?;
    let refname = yoneda_core::transport::hidden_ref(&commit);
    let body = yoneda_core::transport::receive_pack_delete(&refname, commit)?;
    Ok(json!({ "push_b64": STANDARD.encode(body), "refname": refname }))
}

/// The report-status an object store answers with (R2 store).
pub(super) fn push_report(c: &Value) -> Result<Value> {
    let refname = string(c, "refname")?;
    let report = yoneda_core::transport::receive_pack_report(&refname, c["refused"].as_str());
    Ok(json!({ "report_b64": STANDARD.encode(report) }))
}

pub(super) fn push_outcome(c: &Value) -> Result<Value> {
    let report = STANDARD
        .decode(string(c, "report_b64")?)
        .map_err(|_| bad("report_b64 is not base64"))?;
    let refused = yoneda_core::transport::receive_pack_outcome(&report, &string(c, "refname")?)?;
    Ok(json!({ "accepted": refused.is_none(), "refused": refused }))
}

/// Server side of a push for the R2 object store (local development and fallback):
/// unpacks and verifies the objects and answers with Git's report-status.
pub(super) fn receive_pack(c: &Value) -> Result<Value> {
    use yoneda_core::git_object::{PackLimits, read_pack};
    use yoneda_core::transport::parse_receive_pack_request;
    let body = STANDARD
        .decode(
            c["body_b64"]
                .as_str()
                .ok_or_else(|| bad("Missing body_b64"))?,
        )
        .map_err(|_| bad("body_b64 is not base64"))?;
    let push = parse_receive_pack_request(&body)?;
    if push.new == ObjectId::from_bytes([0; 20]) {
        // A delete carries no pack.
        return Ok(
            json!({ "ref": push.refname, "old": push.old, "new": null, "delete": true, "objects": [] }),
        );
    }
    let objects = read_pack(push.pack, PackLimits::default())?
        .into_iter()
        .map(|(kind, data)| {
            let id = hash_object(kind, &data);
            crate::platform_objects::object_json(id, kind, &data)
        })
        .collect::<Result<Vec<_>>>()?;
    // Ref-only updates (projections) carry an empty pack: the store must already hold
    // `new`, which the adapter checks before accepting.
    let contains_new = objects
        .iter()
        .any(|o| o["id"] == json!(push.new) && o["kind"] == "commit");
    Ok(json!({
        "ref": push.refname, "old": push.old, "new": push.new, "objects": objects,
        "contains_new": contains_new,
    }))
}
