//! Bringing a platform commit's tree into the local repository through the API (no
//! `git clone` credential needed): the missing trees and blobs are fetched by id, each
//! verified against its id, and added as one pack per batch. The local commit made on
//! it has the platform's exact tree.
use crate::api::Api;
use crate::error::{Error, Result};
use crate::git::Git;
use base64::Engine;
use serde_json::Value;
use std::collections::HashSet;
use transfer::request;
use yoneda_core::git_object::{
    FileMode, ObjectId, ObjectKind, TreeEntry, encode_tree, hash_object, write_pack,
};

mod transfer;

/// Fetched bytes held before they are written out as a pack.
const PACK_BYTES: usize = 64 * 1024 * 1024;

/// Imports `commit` as a local commit on `parent` with `message`; returns its id.
pub async fn import(
    api: &Api,
    git: &Git,
    commit: &str,
    parent: Option<&str>,
    message: &str,
) -> Result<String> {
    let info = api.commit(commit).await?;
    fetch_tree(api, git, &info.tree).await?;
    git.commit_tree(&info.tree, parent, message)
}

fn mode(kind: &str) -> Result<FileMode> {
    Ok(match kind {
        "tree" => FileMode::Tree,
        "blob" => FileMode::Blob,
        "exec" => FileMode::Executable,
        "symlink" => FileMode::Symlink,
        "gitlink" => FileMode::Gitlink,
        other => return Err(Error::new(format!("unknown tree entry type {other:?}"))),
    })
}

fn object_id(value: &Value, field: &str) -> Result<ObjectId> {
    let hex = value[field].as_str().unwrap_or_default();
    ObjectId::parse(hex).map_err(|e| Error::new(format!("bad object id {hex:?}: {}", e.message)))
}

/// An object's kind and Git bytes, plus the ids (and kinds) of what it references.
type Verified = (ObjectKind, Vec<u8>, Vec<(String, ObjectKind)>);

/// A fetched object as verified Git bytes, plus the ids of what it references.
fn verified(object: &Value) -> Result<Verified> {
    let id = object_id(object, "id")?;
    let (kind, data, refs) = match object["kind"].as_str() {
        Some("tree") => {
            let entries = object["entries"]
                .as_array()
                .ok_or_else(|| Error::new(format!("tree {id} has no entries")))?
                .iter()
                .map(|e| {
                    Ok(TreeEntry {
                        name: e["name"].as_str().unwrap_or_default().to_owned(),
                        mode: mode(e["type"].as_str().unwrap_or_default())?,
                        id: object_id(e, "id")?,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let refs = entries
                .iter()
                .filter_map(|e| match e.mode {
                    FileMode::Tree => Some((e.id.hex(), ObjectKind::Tree)),
                    FileMode::Gitlink => None,
                    _ => Some((e.id.hex(), ObjectKind::Blob)),
                })
                .collect();
            let data = encode_tree(&entries)
                .map_err(|e| Error::new(format!("tree {id}: {}", e.message)))?;
            (ObjectKind::Tree, data, refs)
        }
        Some("blob") => {
            let data = base64::engine::general_purpose::STANDARD
                .decode(object["data_b64"].as_str().unwrap_or_default())
                .map_err(|_| Error::new(format!("blob {id} is not base64")))?;
            (ObjectKind::Blob, data, Vec::new())
        }
        other => {
            return Err(Error::new(format!(
                "unexpected object kind {other:?} for {id}"
            )));
        }
    };
    if hash_object(kind, &data) != id {
        return Err(Error::new(format!(
            "the platform sent {id} with different content"
        )));
    }
    Ok((kind, data, refs))
}

/// Fetches `wanted` objects (paging through the platform's response budget).
async fn fetch(api: &Api, wanted: &[(String, ObjectKind)]) -> Result<Vec<Value>> {
    let (fetched, missing) = request(api, wanted, false).await?;
    if !missing.is_empty() {
        return Err(Error::new(format!(
            "the platform is missing objects: {missing:?}"
        )));
    }
    Ok(fetched)
}

/// A platform commit as served with `raw`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Served {
    /// The exact Git content (verified against its id).
    Exact(Vec<u8>),
    /// Tree and parents only: history the platform holds in its object store alone.
    Shape(CommitShape),
}

/// Each of `ids` (all of which the platform must have) as exact commits where it can.
pub async fn commits(api: &Api, ids: &[String]) -> Result<Vec<(String, Served)>> {
    let wanted: Vec<(String, ObjectKind)> = ids
        .iter()
        .map(|id| (id.clone(), ObjectKind::Commit))
        .collect();
    let (served, missing) = request(api, &wanted, true).await?;
    if !missing.is_empty() {
        return Err(Error::new(format!(
            "the platform is missing commits: {missing:?}"
        )));
    }
    served
        .iter()
        .map(|object| {
            let id = object_id(object, "id")?;
            let Some(b64) = object["data_b64"].as_str() else {
                return Ok((id.hex(), Served::Shape(shape(object)?)));
            };
            let data = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|_| Error::new(format!("commit {id} is not base64")))?;
            if hash_object(ObjectKind::Commit, &data) != id {
                return Err(Error::new(format!(
                    "the platform sent {id} with different content"
                )));
            }
            Ok((id.hex(), Served::Exact(data)))
        })
        .collect()
}

/// The commits among `ids` that the platform has.
pub async fn present(api: &Api, ids: &[String]) -> Result<HashSet<String>> {
    let wanted: Vec<(String, ObjectKind)> = ids
        .iter()
        .map(|id| (id.clone(), ObjectKind::Commit))
        .collect();
    let (_, missing) = request(api, &wanted, false).await?;
    let missing: HashSet<String> = missing.into_iter().collect();
    Ok(ids
        .iter()
        .filter(|id| !missing.contains(*id))
        .cloned()
        .collect())
}

/// Adds `objects` to the local repository as one pack (all or nothing).
pub fn write_objects(git: &Git, objects: Vec<(ObjectKind, Vec<u8>)>) -> Result<()> {
    write(git, &mut { objects })
}

/// Fetches every object under `root` that the local repository lacks.
pub async fn fetch_tree(api: &Api, git: &Git, root: &str) -> Result<()> {
    fetch_trees(api, git, &[root.to_owned()]).await
}

/// Fetches every object under any of `roots` that the local repository lacks, as one
/// walk (shared subtrees are fetched once) written as one pack per 64 MiB.
pub async fn fetch_trees(api: &Api, git: &Git, roots: &[String]) -> Result<()> {
    let mut seen: HashSet<String> = roots.iter().cloned().collect();
    let first = seen.iter().map(|r| (r.clone(), ObjectKind::Tree)).collect();
    let mut wanted = missing(git, first)?;
    let mut pending: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
    let mut pending_bytes = 0usize;
    while !wanted.is_empty() {
        let mut next = Vec::new();
        for object in fetch(api, &wanted).await? {
            let (kind, data, refs) = verified(&object)?;
            next.extend(refs.into_iter().filter(|(id, _)| seen.insert(id.clone())));
            pending_bytes += data.len();
            pending.push((kind, data));
        }
        if pending_bytes > PACK_BYTES {
            write(git, &mut pending)?;
            pending_bytes = 0;
        }
        wanted = missing(git, next)?;
    }
    write(git, &mut pending)
}

/// A platform commit's tree and parents (what `/objects` serves for a commit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitShape {
    pub id: String,
    pub tree: String,
    pub parents: Vec<String>,
}

/// The tree and parents of each of `ids`, through `/objects` (works for imported
/// history too, which has no platform commit record).
pub async fn commit_shapes(api: &Api, ids: &[String]) -> Result<Vec<CommitShape>> {
    let wanted: Vec<(String, ObjectKind)> = ids
        .iter()
        .map(|id| (id.clone(), ObjectKind::Commit))
        .collect();
    fetch(api, &wanted).await?.iter().map(shape).collect()
}

fn shape(object: &Value) -> Result<CommitShape> {
    let parents = object["parents"]
        .as_array()
        .ok_or_else(|| Error::new("a commit object has no parents"))?
        .iter()
        .map(|p| Ok(text_id(p)?.hex()))
        .collect::<Result<Vec<_>>>()?;
    Ok(CommitShape {
        id: object_id(object, "id")?.hex(),
        tree: object_id(object, "tree")?.hex(),
        parents,
    })
}

fn text_id(value: &Value) -> Result<ObjectId> {
    let hex = value.as_str().unwrap_or_default();
    ObjectId::parse(hex).map_err(|e| Error::new(format!("bad object id {hex:?}: {}", e.message)))
}

fn missing(git: &Git, candidates: Vec<(String, ObjectKind)>) -> Result<Vec<(String, ObjectKind)>> {
    let ids: Vec<String> = candidates.iter().map(|(id, _)| id.clone()).collect();
    let absent: HashSet<String> = git.missing(&ids)?.into_iter().collect();
    Ok(candidates
        .into_iter()
        .filter(|(id, _)| absent.contains(id))
        .collect())
}

fn write(git: &Git, pending: &mut Vec<(ObjectKind, Vec<u8>)>) -> Result<()> {
    if pending.is_empty() {
        return Ok(());
    }
    let objects: Vec<(ObjectKind, &[u8])> =
        pending.iter().map(|(k, d)| (*k, d.as_slice())).collect();
    let pack =
        write_pack(&objects).map_err(|e| Error::new(format!("building a pack: {}", e.message)))?;
    git.unpack(&pack)?;
    pending.clear();
    Ok(())
}

#[cfg(test)]
mod fake;
#[cfg(test)]
mod resume_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A local platform stand-in: `POST /objects` answers a page with one large blob as a
    /// stub, `GET /objects/<id>` its bytes; every request line is recorded.
    async fn platform(
        blob: Vec<u8>,
        id: String,
    ) -> Result<(String, std::sync::Arc<std::sync::Mutex<Vec<String>>>)> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| Error::new(e.to_string()))?;
        let origin = format!(
            "http://{}",
            listener
                .local_addr()
                .map_err(|e| Error::new(e.to_string()))?
        );
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = vec![0u8; 8192];
                let n = socket.read(&mut request).await.unwrap_or(0);
                let line = String::from_utf8_lossy(&request[..n])
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                if let Ok(mut log) = log.lock() {
                    log.push(line.clone());
                }
                let (status, kind, body) = if line.starts_with("POST /api/v1/objects ") {
                    let page = json!({ "objects": [{ "id": id, "kind": "blob", "size": blob.len(), "large": true }],
                        "missing": [], "next": null });
                    ("200 OK", "application/json", page.to_string().into_bytes())
                } else if line.starts_with(&format!("GET /api/v1/objects/{id} ")) {
                    ("200 OK", "application/octet-stream", blob.clone())
                } else {
                    (
                        "503 Service Unavailable",
                        "text/html",
                        b"<html>limits</html>".to_vec(),
                    )
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&body).await;
            }
        });
        Ok((origin, seen))
    }

    /// A blob served as a stub is downloaded on its own request and verified like any other.
    #[tokio::test]
    async fn downloads_a_large_blob_the_page_only_names() -> Result<()> {
        let blob = vec![7u8; 3 * 1024 * 1024];
        let id = hash_object(ObjectKind::Blob, &blob).hex();
        let (origin, seen) = platform(blob.clone(), id.clone()).await?;
        let api = Api::account(&origin, None)?;
        let fetched = fetch(&api, &[(id.clone(), ObjectKind::Blob)]).await?;
        let (kind, data, _) = verified(&fetched[0])?;
        assert_eq!((kind, data.len()), (ObjectKind::Blob, blob.len()));
        let lines = seen.lock().map(|l| l.clone()).unwrap_or_default();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[1].starts_with(&format!("GET /api/v1/objects/{id} ")));
        Ok(())
    }

    /// A platform that 503s on pages of more than two ids (a Worker over its limits) still
    /// serves every object: the client asks again for half as many ids.
    #[tokio::test]
    async fn halves_a_page_the_platform_cannot_answer() -> Result<()> {
        let blobs: Vec<Vec<u8>> = (0..4u8).map(|i| vec![i; 64]).collect();
        let ids: Vec<String> = blobs
            .iter()
            .map(|b| hash_object(ObjectKind::Blob, b).hex())
            .collect();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| Error::new(e.to_string()))?;
        let origin = format!(
            "http://{}",
            listener
                .local_addr()
                .map_err(|e| Error::new(e.to_string()))?
        );
        let sizes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = sizes.clone();
        let served = blobs.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut chunk = [0u8; 8192];
                // Headers, then the body its content-length announces.
                loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    request.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(str::to_owned)
                            })
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if n == 0 || request.len() >= end + 4 + length {
                            break;
                        }
                    } else if n == 0 {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&request).to_string();
                let body: Value = text
                    .split_once("\r\n\r\n")
                    .and_then(|(_, b)| serde_json::from_str(b).ok())
                    .unwrap_or(Value::Null);
                let asked: Vec<String> = body["objects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|o| o["id"].as_str().map(str::to_owned))
                    .collect();
                if let Ok(mut log) = seen.lock() {
                    log.push(asked.len());
                }
                let (status, kind, reply) = if asked.len() > 2 {
                    (
                        "503 Service Unavailable",
                        "text/html",
                        "<html>limits</html>".to_owned(),
                    )
                } else {
                    let objects: Vec<Value> = asked
                        .iter()
                        .filter_map(|id| {
                            served
                                .iter()
                                .find(|b| hash_object(ObjectKind::Blob, b).hex() == *id)
                                .map(|b| json!({ "id": id, "kind": "blob",
                                    "data_b64": base64::engine::general_purpose::STANDARD.encode(b) }))
                        })
                        .collect();
                    let page = json!({ "objects": objects, "missing": [], "next": null });
                    ("200 OK", "application/json", page.to_string())
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    reply.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        let api = Api::account(&origin, None)?;
        let wanted: Vec<(String, ObjectKind)> = ids
            .iter()
            .map(|id| (id.clone(), ObjectKind::Blob))
            .collect();
        let fetched = fetch(&api, &wanted).await?;
        let got: Vec<String> = fetched
            .iter()
            .map(|o| o["id"].as_str().unwrap_or_default().to_owned())
            .collect();
        assert_eq!(got, ids);
        let asked = sizes.lock().map(|l| l.clone()).unwrap_or_default();
        // Four ids refused (with the client's own retries), then two pages of two.
        assert_eq!(asked.iter().filter(|n| **n == 4).count(), 4, "{asked:?}");
        assert_eq!(asked.iter().filter(|n| **n == 2).count(), 2, "{asked:?}");
        Ok(())
    }

    /// A gateway's non-JSON error names the request it answered.
    #[tokio::test]
    async fn a_platform_error_without_json_names_its_request() -> Result<()> {
        let (origin, _) = platform(Vec::new(), "0".repeat(40)).await?;
        let api = Api::account(&origin, None)?;
        let failed = api.get_bytes("/elsewhere").await;
        let Err(failure) = failed else {
            return Err(Error::new("the 503 was not an error"));
        };
        assert_eq!(failure.status, 503);
        assert_eq!(failure.message, "HTTP 503 from /api/v1/elsewhere");
        Ok(())
    }
}
