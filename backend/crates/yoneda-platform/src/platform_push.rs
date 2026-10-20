//! Push batching for object stores that take one receive-pack per repository at a time
//! (Artifacts): the push queue combines waiting pushes and splits the report per ref.
//! Staged commits (accepted before the store held them) are pushed from their objects.
use crate::platform_objects::object_json;
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::git_object::{
    Commit, ObjectId, ObjectKind, combine_receive_pack_requests, hash_object, hidden_ref,
    receive_pack_request, split_receive_pack_report, write_pack,
};
use yoneda_core::{Error, Result};

pub fn push_combine(c: &Value) -> Result<Value> {
    let bodies = c["bodies_b64"]
        .as_array()
        .filter(|b| !b.is_empty())
        .ok_or_else(|| bad("bodies_b64 must be a non-empty array"))?
        .iter()
        .map(|b| {
            b.as_str()
                .and_then(|b| STANDARD.decode(b).ok())
                .ok_or_else(|| bad("bodies_b64 entries must be base64"))
        })
        .collect::<Result<Vec<_>>>()?;
    let slices: Vec<&[u8]> = bodies.iter().map(Vec::as_slice).collect();
    let (body, refs) = combine_receive_pack_requests(&slices)?;
    Ok(json!({ "push_b64": STANDARD.encode(body), "refs": refs }))
}

pub fn push_split(c: &Value) -> Result<Value> {
    let report = STANDARD
        .decode(string(c, "report_b64")?)
        .map_err(|_| bad("report_b64 is not base64"))?;
    let split = split_receive_pack_report(&report, &string(c, "refname")?)?;
    Ok(json!({ "report_b64": STANDARD.encode(split) }))
}

/// The receive-pack request creating a staged commit's hidden ref, from the raw objects the
/// authority staged for it; each must hash to its id and the commit must be among them.
pub fn staged_push(c: &Value) -> Result<Value> {
    let commit = ObjectId::parse(&string(c, "commit")?)?;
    let mut objects = Vec::new();
    for object in c["objects"]
        .as_array()
        .ok_or_else(|| bad("objects must be a list"))?
    {
        let kind = match object["kind"].as_str() {
            Some("commit") => ObjectKind::Commit,
            Some("tree") => ObjectKind::Tree,
            Some("blob") => ObjectKind::Blob,
            _ => return Err(bad("Staged objects are commits, trees or blobs")),
        };
        let data = STANDARD
            .decode(object["data_b64"].as_str().unwrap_or_default())
            .map_err(|_| bad("data_b64 is not base64"))?;
        if hash_object(kind, &data) != ObjectId::parse(&string(object, "id")?)? {
            return Err(Error::new(
                "OBJECT_INVALID",
                "A staged object does not match its id",
            ));
        }
        objects.push((kind, data));
    }
    let header = objects
        .iter()
        .find(|(k, d)| *k == ObjectKind::Commit && hash_object(*k, d) == commit)
        .map(|(_, d)| Commit::decode(d))
        .ok_or_else(|| bad("The staged objects do not include the commit"))??;
    let pack = write_pack(
        &objects
            .iter()
            .map(|(k, d)| (*k, d.as_slice()))
            .collect::<Vec<_>>(),
    )?;
    let body = receive_pack_request(&hidden_ref(&commit), None, commit, &pack)?;
    // The readback to expect, and structured copies for the adapter's cache tiers.
    Ok(json!({
        "push_b64": STANDARD.encode(body),
        "tree": header.tree()?,
        "parents": header.parents()?,
        "objects": objects.iter().map(|(k, d)| object_json(hash_object(*k, d), *k, d)).collect::<Result<Vec<_>>>()?,
    }))
}
