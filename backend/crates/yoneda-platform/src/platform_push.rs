//! Push batching for object stores that take one receive-pack per repository at a time
//! (Artifacts): the push queue combines waiting pushes and splits the report per ref.
//! Staged commits (accepted before the store held them) are pushed from their objects.
use crate::platform_objects::object_json;
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::git_object::{
    Commit, FileMode, ObjectId, ObjectKind, TreeEntry, encode_tree, hash_object, write_pack,
};
use yoneda_core::transport::{
    combine_receive_pack_requests, hidden_ref, receive_pack_request, split_receive_pack_report,
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

/// A chunk of a commit too large for one pack (`objects`: raw blobs) pushed on its own: a
/// carrier tree naming each blob by its id and a carrier commit of that tree keep them
/// reachable under the carrier's hidden ref, so the store's connectivity check accepts the
/// chunk and the commit's own push (its trees, which name the blobs) can follow. The
/// carrier is the same for the same blobs, so a retried chunk repeats its push exactly.
pub fn carrier_push(c: &Value) -> Result<Value> {
    let mut objects = raw_objects(c)?;
    if objects.is_empty() || objects.iter().any(|(k, _)| *k != ObjectKind::Blob) {
        return Err(bad("A carrier holds one or more blobs"));
    }
    // One entry per blob (a chunk may name one twice).
    let mut ids = std::collections::BTreeSet::new();
    objects.retain(|(k, d)| ids.insert(hash_object(*k, d)));
    let (tree, commit, commit_id) = carrier(ids)?;
    let mut packed: Vec<(ObjectKind, &[u8])> =
        objects.iter().map(|(k, d)| (*k, d.as_slice())).collect();
    packed.push((ObjectKind::Tree, &tree));
    packed.push((ObjectKind::Commit, &commit));
    let body = receive_pack_request(
        &hidden_ref(&commit_id),
        None,
        commit_id,
        &write_pack(&packed)?,
    )?;
    Ok(json!({ "push_b64": STANDARD.encode(body), "commit": commit_id }))
}

/// A carrier of `ids` (blobs): a tree naming each by its id and a commit of that tree,
/// the same for the same blobs; their bytes and the commit's id.
fn carrier(ids: std::collections::BTreeSet<ObjectId>) -> Result<(Vec<u8>, Vec<u8>, ObjectId)> {
    let entries: Vec<TreeEntry> = ids
        .into_iter()
        .map(|id| TreeEntry {
            name: id.hex(),
            mode: FileMode::Blob,
            id,
        })
        .collect();
    let tree = encode_tree(&entries)?;
    let tree_id = hash_object(ObjectKind::Tree, &tree);
    let who = "YonedaRepo projection <projection@yoneda.invalid> 0 +0000";
    let commit = format!("tree {tree_id}\nauthor {who}\ncommitter {who}\n\ncarrier\n").into_bytes();
    let commit_id = hash_object(ObjectKind::Commit, &commit);
    Ok((tree, commit, commit_id))
}

/// `large_carrier`: a carrier of one file too large to hold (`id`), for the adapter to
/// stream: the receive-pack request's head (the hidden ref's creation), and the carrier
/// tree and commit to write after the file in the pack (see `carrier_push`).
pub fn large_carrier(c: &Value) -> Result<Value> {
    let id = ObjectId::parse(&string(c, "id")?)?;
    let (tree, commit, commit_id) = carrier([id].into_iter().collect())?;
    let head = receive_pack_request(&hidden_ref(&commit_id), None, commit_id, &[])?;
    Ok(json!({
        "head_b64": STANDARD.encode(head), "commit": commit_id,
        "tree_b64": STANDARD.encode(tree), "commit_b64": STANDARD.encode(commit),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform_compute::compute;

    #[test]
    fn a_carrier_keeps_its_blobs_reachable_under_its_own_hidden_ref() {
        let blob = |text: &str| {
            json!({ "id": hash_object(ObjectKind::Blob, text.as_bytes()),
            "kind": "blob", "data_b64": STANDARD.encode(text) })
        };
        let chunk = json!({ "objects": [blob("one\n"), blob("two\n"), blob("one\n")] });
        let pushed = carrier_push(&chunk).unwrap();
        assert_eq!(
            carrier_push(&chunk).unwrap(),
            pushed,
            "the same chunk, the same push"
        );
        let received =
            compute(json!({ "op": "receive_pack", "body_b64": pushed["push_b64"] })).unwrap();
        let commit = pushed["commit"].as_str().unwrap();
        assert_eq!(received["ref"], format!("refs/yoneda/c/{commit}"));
        let kinds: Vec<&str> = received["objects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["blob", "blob", "tree", "commit"]);
        let tree = &received["objects"][2]["entries"];
        assert_eq!(tree.as_array().unwrap().len(), 2);
        let trees = json!({ "objects": [{ "id": hash_object(ObjectKind::Tree, b""), "kind": "tree", "data_b64": "" }] });
        assert!(carrier_push(&trees).is_err(), "blobs only");
        assert!(carrier_push(&json!({ "objects": [] })).is_err());
        // A large file's carrier is the same as if its bytes were pushed in one.
        let one = carrier_push(&json!({ "objects": [blob("one\n")] })).unwrap();
        let id = hash_object(ObjectKind::Blob, b"one\n");
        let large = large_carrier(&json!({ "id": id })).unwrap();
        assert_eq!(large["commit"], one["commit"]);
        let head = STANDARD
            .decode(large["head_b64"].as_str().unwrap())
            .unwrap();
        assert!(String::from_utf8_lossy(&head).contains(&format!(
            "refs/yoneda/c/{}",
            one["commit"].as_str().unwrap()
        )));
        assert!(head.ends_with(b"0000"));
    }
}
