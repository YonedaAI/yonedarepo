//! Verification rounds of a push (`ReceiveSession::verify`), supplied as
//! `repo-git-objects.ts` `supply` does: recorded parents' trees from the authority, trees
//! and files from the store. Anything missing refuses the push.
use crate::authority::Cred;
use crate::service::Service;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, ObjectKind},
};
use yoneda_platform::platform_git_receive::ReceiveSession;

const VERIFY_ROUNDS: usize = 64;

fn missing(what: String) -> Error {
    Error::new(
        "NOT_FOUND",
        format!("missing necessary objects: {what} is not in this repository"),
    )
}

fn ids(list: &Value) -> Result<Vec<ObjectId>> {
    list.as_array()
        .into_iter()
        .flatten()
        .map(|id| ObjectId::parse(id.as_str().unwrap_or_default()))
        .collect()
}

/// Verifies `tips`; answers the session's `{verified, objects}`.
pub fn run(
    svc: &Service,
    cred: &Cred,
    session: &mut ReceiveSession,
    tips: &[String],
    access: &Value,
) -> Result<Value> {
    let mut input = json!({ "tips": tips, "secret_allow": access["secret_allow"] });
    for _ in 0..VERIFY_ROUNDS {
        let step = session.verify(&input)?;
        let Some(need) = step.get("need") else {
            return Ok(step);
        };
        input = supply(svc, cred, need)?;
        input["tips"] = json!(tips);
    }
    Err(Error::new(
        "INVALID_INPUT",
        "Directories are nested too deeply",
    ))
}

fn supply(svc: &Service, cred: &Cred, need: &Value) -> Result<Value> {
    if let Some(commits) = need.get("commits") {
        let mut trees = Map::new();
        for id in ids(commits)? {
            let found = svc
                .authority
                .call(
                    cred,
                    json!({ "op": "repo_commit", "commit": id, "brief": true }),
                )
                .map_err(|e| {
                    if e.code == "NOT_FOUND" {
                        missing(format!("commit {id}"))
                    } else {
                        e
                    }
                })?;
            trees.insert(id.hex(), found["tree"].clone());
        }
        return Ok(json!({ "commits": trees }));
    }
    if let Some(trees) = need.get("trees") {
        let wanted = ids(trees)?;
        let found = svc.store.read(&wanted)?;
        let mut listed = Vec::new();
        for id in wanted {
            let (_, data) = found
                .get(&id)
                .ok_or_else(|| missing(format!("tree {id}")))?;
            listed.push(json!({ "id": id, "data_b64": STANDARD.encode(data) }));
        }
        return Ok(json!({ "trees": listed }));
    }
    let asked = ids(&need["objects"])?;
    let held = svc.store.holds(&asked, "blob")?;
    if let Some(id) = asked.iter().find(|id| !held.contains(id)) {
        return Err(missing(format!("file {id}")));
    }
    Ok(json!({ "present": held }))
}

/// Objects from `next_objects` frames: kind (1 commit, 2 tree, 3 blob), 20-byte id,
/// 4-byte big-endian length, content.
pub fn framed(frames: &[u8]) -> Result<Vec<(ObjectKind, Vec<u8>)>> {
    let bad = || Error::new("LOCAL", "Malformed object frames");
    let mut out = Vec::new();
    let mut at = 0;
    while at < frames.len() {
        let kind = match frames[at] {
            1 => ObjectKind::Commit,
            2 => ObjectKind::Tree,
            3 => ObjectKind::Blob,
            _ => return Err(bad()),
        };
        let len = frames.get(at + 21..at + 25).ok_or_else(bad)?;
        let len = u32::from_be_bytes([len[0], len[1], len[2], len[3]]) as usize;
        let data = frames.get(at + 25..at + 25 + len).ok_or_else(bad)?;
        out.push((kind, data.to_vec()));
        at += 25 + len;
    }
    Ok(out)
}
