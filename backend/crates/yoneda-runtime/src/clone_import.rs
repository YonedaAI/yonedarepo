//! `git clone` on the check container's disk, for `cloneRepository` (repo-clone.ts): the Worker
//! reads what it fetched from here and hands it to what a push stores and records with. `POST
//! /clone` waits for the clone and answers what it holds; then `GET /clone/pack` is its pack,
//! `/clone/objects?from=` every object framed, `/clone/commits?from=&count=` commits parents
//! first and `/clone/refs` its branches and tags. One clone an instance, and the Worker
//! destroys the instance after it. Nothing of the clone's content runs: it is bare, with no
//! hooks. The credential of a private remote, if any, is in this process's environment.
use crate::check_runner::{check_dir, hand_over, invalid, valid_timeout};
use crate::check_server::{answer, authorized, forbidden};
use crate::clone_git::{Credential, Limits, bare_clone, only_pack, output};
use crate::clone_history::{Link, all_commits, commit_lines};
use crate::clone_read::{Ref, all_objects, all_refs, file_body, frames_body};
use crate::clone_remote::{check_resolved, check_url};
use crate::err;
use axum::extract::Query;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use yoneda_core::Result;
use yoneda_core::git_object::ObjectId;

/// Commits one read of `/clone/commits` lists at most.
const MAX_COMMITS: usize = 5000;
const PACK_HEADER: usize = 12;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloneRequest {
    pub url: String,
    pub max_pack_bytes: u64,
    pub timeout_seconds: u64,
}

/// A finished clone, on disk until the instance goes.
pub struct Cloned {
    _dir: tempfile::TempDir,
    repo: PathBuf,
    pack: PathBuf,
    objects: Arc<Vec<ObjectId>>,
    commits: Vec<Link>,
    refs: Vec<Ref>,
}

#[cfg(test)]
impl Cloned {
    pub(crate) fn repo(&self) -> &Path {
        &self.repo
    }
    pub(crate) fn pack(&self) -> &Path {
        &self.pack
    }
    pub(crate) fn objects(&self) -> Arc<Vec<ObjectId>> {
        self.objects.clone()
    }
    pub(crate) fn commits(&self) -> &[Link] {
        &self.commits
    }
    pub(crate) fn refs_json(&self) -> Value {
        json!(self.refs)
    }
}

/// Clones an address held to the rules (`clone_remote`).
pub(crate) async fn clone_remote(
    request: CloneRequest,
    credential: &Credential,
) -> Result<(Cloned, Value)> {
    let host = check_url(&request.url)?;
    check_resolved(&host).await?;
    clone_with(request, "https", credential).await
}

/// How many objects the pack at `path` says it holds.
async fn pack_objects(path: &Path) -> Result<u32> {
    let mut file = tokio::fs::File::open(path).await.map_err(err)?;
    let mut header = [0u8; PACK_HEADER];
    file.read_exact(&mut header).await.map_err(err)?;
    if &header[..4] != b"PACK" {
        return Err(err("The clone's pack is not a pack"));
    }
    Ok(u32::from_be_bytes([
        header[8], header[9], header[10], header[11],
    ]))
}

/// The remote's default branch: what a bare clone's HEAD names, if that came.
async fn default_branch(repo: &Path) -> Option<String> {
    let args = ["symbolic-ref", "--short", "HEAD"];
    let named = output(repo, &args, Vec::new()).await.ok()?;
    let name = String::from_utf8_lossy(&named).trim().to_owned();
    let held = format!("refs/heads/{name}^{{commit}}");
    let args = ["rev-parse", "--verify", "--quiet", held.as_str()];
    output(repo, &args, Vec::new()).await.ok().map(|_| name)
}

/// Clones with `protocol` the only one Git may speak; `clone_remote` is the way in.
pub(crate) async fn clone_with(
    request: CloneRequest,
    protocol: &str,
    credential: &Credential,
) -> Result<(Cloned, Value)> {
    let limits = Limits {
        pack_bytes: request.max_pack_bytes,
        time: valid_timeout(request.timeout_seconds)?,
    };
    let dir = check_dir()?;
    hand_over(dir.path())?;
    let repo = bare_clone(dir.path(), &request.url, protocol, credential, &limits).await?;
    let pack = only_pack(&repo)?;
    let (refs, refs_skipped) = all_refs(&repo).await?;
    let objects = all_objects(&repo).await?;
    let commits = all_commits(&repo).await?;
    let summary = json!({
        "default_branch": default_branch(&repo).await,
        "pack_bytes": std::fs::metadata(&pack).map_err(err)?.len(),
        "pack_objects": pack_objects(&pack).await?,
        "objects": objects.len(),
        "commits": commits.len(),
        "refs": refs.len(),
        "refs_skipped": refs_skipped,
    });
    let cloned = Cloned {
        _dir: dir,
        repo,
        pack,
        objects: Arc::new(objects),
        commits,
        refs,
    };
    Ok((cloned, summary))
}

/// The clone of this instance, once there is one.
#[derive(Clone)]
struct Held {
    secret: String,
    credential: Credential,
    clone: Arc<tokio::sync::Mutex<Option<Arc<Cloned>>>>,
}

impl Held {
    /// The finished clone, or `None` while there is none or it is being taken.
    fn finished(&self) -> Option<Arc<Cloned>> {
        self.clone.try_lock().ok().and_then(|held| held.clone())
    }

    /// The clone, for the holder of the secret; anyone else gets the answer to give them.
    fn reader(&self, headers: &HeaderMap) -> std::result::Result<Arc<Cloned>, Box<Response>> {
        if !authorized(&self.secret, headers) {
            return Err(Box::new(forbidden()));
        }
        self.finished()
            .ok_or_else(|| Box::new(answer(Err(invalid("There is no clone to read")))))
    }
}

async fn take(held: Held, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    if !authorized(&held.secret, &headers) {
        return forbidden();
    }
    let request: CloneRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(e) => return answer(Err(invalid(e.to_string()))),
    };
    let Ok(mut slot) = held.clone.try_lock() else {
        return answer(Err(invalid("A clone is running")));
    };
    if slot.is_some() {
        return answer(Err(invalid("This instance has taken its clone")));
    }
    tracing::info!(event = "clone.started");
    match clone_remote(request, &held.credential).await {
        Ok((clone, summary)) => {
            tracing::info!(event = "clone.finished");
            *slot = Some(Arc::new(clone));
            answer(Ok(summary))
        }
        Err(e) => {
            tracing::warn!(event = "clone.failed", error_code = %e.code);
            answer(Err(e))
        }
    }
}

#[derive(Deserialize)]
struct Slice {
    from: usize,
    #[serde(default)]
    count: usize,
}

/// The commits of `slice`, a line each.
async fn commits(held: Held, headers: HeaderMap, Query(slice): Query<Slice>) -> Response {
    let clone = match held.reader(&headers) {
        Ok(clone) => clone,
        Err(answer) => return *answer,
    };
    let end = slice.from.saturating_add(slice.count.min(MAX_COMMITS));
    let links = &clone.commits[slice.from.min(clone.commits.len())..end.min(clone.commits.len())];
    match commit_lines(&clone.repo, links).await {
        Ok(lines) => lines.into_response(),
        Err(e) => answer(Err(e)),
    }
}

/// The routes of a clone, on an instance holding `clone` already.
pub(crate) fn routes_holding(
    secret: String,
    credential: Credential,
    clone: Option<Cloned>,
) -> axum::Router {
    use axum::routing::{get, post};
    let held = Held {
        secret,
        credential,
        clone: Arc::new(tokio::sync::Mutex::new(clone.map(Arc::new))),
    };
    let (posted, packed, framed, listed, named) =
        (held.clone(), held.clone(), held.clone(), held.clone(), held);
    axum::Router::new()
        .route(
            "/clone",
            post(move |headers: HeaderMap, body: axum::body::Bytes| take(posted, headers, body)),
        )
        .route(
            "/clone/pack",
            get(move |headers: HeaderMap| async move {
                match packed.reader(&headers) {
                    Ok(clone) => file_body(clone.pack.clone()).into_response(),
                    Err(answer) => *answer,
                }
            }),
        )
        .route(
            "/clone/objects",
            get(
                move |headers: HeaderMap, Query(slice): Query<Slice>| async move {
                    match framed.reader(&headers) {
                        Ok(clone) => {
                            frames_body(clone.repo.clone(), clone.objects.clone(), slice.from)
                                .into_response()
                        }
                        Err(answer) => *answer,
                    }
                },
            ),
        )
        .route(
            "/clone/commits",
            get(move |headers: HeaderMap, slice: Query<Slice>| commits(listed, headers, slice)),
        )
        .route(
            "/clone/refs",
            get(move |headers: HeaderMap| async move {
                match named.reader(&headers) {
                    Ok(clone) => {
                        let lines: String = clone
                            .refs
                            .iter()
                            .map(|r| format!("{}\n", json!(r)))
                            .collect();
                        lines.into_response()
                    }
                    Err(answer) => *answer,
                }
            }),
        )
}
