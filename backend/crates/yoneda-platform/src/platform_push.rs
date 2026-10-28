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

/// Raw objects (`{id, kind, data_b64}`), each verified against its id.
pub fn raw_objects(c: &Value) -> Result<Vec<(ObjectKind, Vec<u8>)>> {
    c["objects"]
        .as_array()
        .ok_or_else(|| bad("objects must be a list"))?
        .iter()
        .map(|object| {
            let kind = match object["kind"].as_str() {
                Some("commit") => ObjectKind::Commit,
                Some("tree") => ObjectKind::Tree,
                Some("blob") => ObjectKind::Blob,
                Some("tag") => ObjectKind::Tag,
                _ => return Err(bad("Objects are commits, trees, blobs or tags")),
            };
            let data = STANDARD
                .decode(object["data_b64"].as_str().unwrap_or_default())
                .map_err(|_| bad("data_b64 is not base64"))?;
            if hash_object(kind, &data) != ObjectId::parse(&string(object, "id")?)? {
                return Err(Error::new(
                    "OBJECT_INVALID",
                    "An object does not match its id",
                ));
            }
            Ok((kind, data))
        })
        .collect()
}

/// A protected branch's projection: its new objects and the ref update (with the last
/// projected value as the expected old one) in one receive-pack request.
pub fn branch_push(c: &Value) -> Result<Value> {
    let refname = string(c, "refname")?;
    if !refname.starts_with("refs/heads/") && !refname.starts_with("refs/tags/") {
        return Err(bad("Only branch and tag refs are projected"));
    }
    let old = match c.get("old").filter(|o| !o.is_null()) {
        Some(_) => Some(ObjectId::parse(&string(c, "old")?)?),
        None => None,
    };
    let objects = raw_objects(c)?;
    let pack = write_pack(
        &objects
            .iter()
            .map(|(k, d)| (*k, d.as_slice()))
            .collect::<Vec<_>>(),
    )?;
    let body = receive_pack_request(&refname, old, ObjectId::parse(&string(c, "new")?)?, &pack)?;
    Ok(json!({ "push_b64": STANDARD.encode(body) }))
}

/// The receive-pack request creating a staged commit's hidden ref, from the raw objects the
/// authority staged for it; each must hash to its id and the commit must be among them.
pub fn staged_push(c: &Value) -> Result<Value> {
    let commit = ObjectId::parse(&string(c, "commit")?)?;
    let objects = raw_objects(c)?;
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

/// The structured form of raw objects read from the store of record (R2), verified.
pub fn parse_objects(c: &Value) -> Result<Value> {
    let objects = raw_objects(c)?
        .iter()
        .map(|(k, d)| object_json(hash_object(*k, d), *k, d))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({ "objects": objects }))
}
