//! Objects as an adapter hands them to compute, and a branch update's receive-pack request.
use crate::platform_objects::object_json;
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::git_object::{ObjectId, ObjectKind, hash_object, write_pack};
use yoneda_core::transport::receive_pack_request;
use yoneda_core::{Error, Result};

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

/// The structured form of raw objects read from the store of record (R2), verified.
pub fn parse_objects(c: &Value) -> Result<Value> {
    let objects = raw_objects(c)?
        .iter()
        .map(|(k, d)| object_json(hash_object(*k, d), *k, d))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({ "objects": objects }))
}
