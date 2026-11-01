//! The objects and refs of a cloned repository as the Worker reads them: every object framed
//! as a push's are, and its branches and tags. A body whose sender fails ends unfinished, so
//! its reader finds out.
use crate::clone_git::{feed, git, output};
use crate::err;
use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStdout};
use tokio::sync::mpsc;
use yoneda_core::git_object::{AnnotatedTag, ObjectId};
use yoneda_core::{Error, Result};

/// Bytes of a file sent at once.
const CHUNK: usize = 256 * 1024;

pub(crate) fn bad(message: impl Into<String>) -> Error {
    Error::new("GIT_FAILED", message)
}

/// What `git cat-file --batch` hands out, one object at a time.
pub(crate) struct Objects {
    process: Child,
    stdout: BufReader<ChildStdout>,
    _feeding: tokio::task::JoinHandle<()>,
}

/// One object's header line.
pub(crate) struct Found {
    pub id: ObjectId,
    kind: String,
    size: u64,
}

impl Objects {
    pub(crate) fn open(repo: &Path, ids: &[ObjectId]) -> Result<Self> {
        let mut command = git(repo);
        command
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stderr(Stdio::null());
        let mut process = command.spawn().map_err(err)?;
        let input: String = ids.iter().map(|id| format!("{id}\n")).collect();
        let feeding = feed(&mut process, input.into_bytes());
        let stdout = process
            .stdout
            .take()
            .ok_or_else(|| err("No object output"))?;
        Ok(Self {
            process,
            stdout: BufReader::new(stdout),
            _feeding: feeding,
        })
    }

    pub(crate) async fn next(&mut self) -> Result<Found> {
        let mut line = String::new();
        self.stdout.read_line(&mut line).await.map_err(err)?;
        let mut parts = line.split_ascii_whitespace();
        let (Some(id), Some(kind), Some(size)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(bad(format!("The clone does not hold {}", line.trim())));
        };
        Ok(Found {
            id: ObjectId::parse(id)?,
            kind: kind.to_owned(),
            size: size.parse().map_err(err)?,
        })
    }

    /// The object `found` introduced, whole.
    pub(crate) async fn content(&mut self, found: &Found) -> Result<Vec<u8>> {
        let mut content = Vec::new();
        (&mut self.stdout)
            .take(found.size)
            .read_to_end(&mut content)
            .await
            .map_err(err)?;
        self.end().await?;
        Ok(content)
    }

    /// The newline after an object.
    async fn end(&mut self) -> Result<()> {
        self.stdout.read_u8().await.map_err(err)?;
        Ok(())
    }

    /// Ends the child; what it was asked for has been read.
    pub(crate) async fn close(mut self) {
        let _ = self.process.kill().await;
    }
}

/// Every commit, tree and file the clone holds, as Git keeps them, so that what deltas against
/// each other stays close. Tags are not among them: a tag object stays with its ref.
pub(crate) async fn all_objects(repo: &Path) -> Result<Vec<ObjectId>> {
    let args = [
        "cat-file",
        "--batch-check=%(objecttype) %(objectname)",
        "--batch-all-objects",
        "--unordered",
    ];
    let listed = output(repo, &args, Vec::new()).await?;
    let mut ids = Vec::new();
    for line in String::from_utf8_lossy(&listed).lines() {
        match line.split_once(' ') {
            Some(("tag", _)) => {}
            Some((_, id)) => ids.push(ObjectId::parse(id)?),
            None => return Err(bad(format!("Unreadable object {line}"))),
        }
    }
    Ok(ids)
}

/// A branch or tag and what it is at. A tag's object comes along, byte for byte, so that its
/// id stays the one Git computed.
#[derive(Serialize)]
pub(crate) struct Ref {
    #[serde(rename = "ref")]
    name: String,
    /// What a client asks for by this ref: a tag's object where it has one.
    id: ObjectId,
    commit: ObjectId,
    #[serde(skip_serializing_if = "Option::is_none")]
    tag_b64: Option<String>,
}

/// The clone's branches and tags, and how many it left out: a ref must name a commit, and a
/// tag of a tree or a file names none. A tag object the platform could not keep leaves its ref
/// at the commit it tags.
pub(crate) async fn all_refs(repo: &Path) -> Result<(Vec<Ref>, usize)> {
    let args = [
        "for-each-ref",
        "--format=%(refname) %(objecttype) %(objectname) %(*objecttype) %(*objectname)",
        "refs/heads",
        "refs/tags",
    ];
    let listed = String::from_utf8_lossy(&output(repo, &args, Vec::new()).await?).into_owned();
    let mut refs = Vec::new();
    let mut tags = Vec::new();
    let mut skipped = 0;
    for line in listed.lines() {
        let fields: Vec<&str> = line.split(' ').collect();
        let [name, kind, id, peeled_kind, peeled] = fields[..] else {
            return Err(bad(format!("Unreadable ref {line}")));
        };
        let (commit, tag) = match (kind, peeled_kind) {
            ("commit", _) => (id, None),
            ("tag", "commit") => (peeled, Some(ObjectId::parse(id)?)),
            _ => {
                skipped += 1;
                continue;
            }
        };
        let commit = ObjectId::parse(commit)?;
        if let Some(tag) = tag {
            tags.push((refs.len(), tag));
        }
        refs.push(Ref {
            name: name.to_owned(),
            id: ObjectId::parse(id)?,
            commit,
            tag_b64: None,
        });
    }
    let ids: Vec<ObjectId> = tags.iter().map(|(_, tag)| *tag).collect();
    let mut objects = Objects::open(repo, &ids)?;
    for (at, _) in tags {
        let found = objects.next().await?;
        let data = objects.content(&found).await?;
        let kept = AnnotatedTag::decode(&data).is_ok_and(|tag| tag.object == refs[at].commit);
        refs[at].tag_b64 = kept.then(|| STANDARD.encode(&data));
    }
    objects.close().await;
    Ok((refs, skipped))
}

fn frame(found: &Found) -> Result<Vec<u8>> {
    let kind = match found.kind.as_str() {
        "commit" => 1,
        "tree" => 2,
        "blob" => 3,
        other => return Err(bad(format!("Unexpected object kind {other}"))),
    };
    let size = u32::try_from(found.size).map_err(|_| bad("A file is over 4 GiB"))?;
    let mut out = Vec::with_capacity(25);
    out.push(kind);
    out.extend_from_slice(found.id.as_bytes());
    out.extend_from_slice(&size.to_be_bytes());
    Ok(out)
}

/// What `tx` is given, as a body.
fn channel_body(rx: mpsc::Receiver<std::io::Result<Bytes>>) -> axum::body::Body {
    axum::body::Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    }))
}

/// Sends what `from` holds of `left` bytes; false once nobody is reading.
async fn send_bytes(
    from: &mut (impl AsyncRead + Unpin),
    mut left: u64,
    tx: &mpsc::Sender<std::io::Result<Bytes>>,
) -> Result<bool> {
    let mut buffer = vec![0u8; CHUNK];
    while left > 0 {
        let want = usize::try_from(left).unwrap_or(CHUNK).min(CHUNK);
        let count = from.read(&mut buffer[..want]).await.map_err(err)?;
        if count == 0 {
            return Err(bad("An object ended early"));
        }
        left -= count as u64;
        if tx
            .send(Ok(Bytes::copy_from_slice(&buffer[..count])))
            .await
            .is_err()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn send_frames(
    repo: &Path,
    ids: &[ObjectId],
    tx: &mpsc::Sender<std::io::Result<Bytes>>,
) -> Result<()> {
    let mut objects = Objects::open(repo, ids)?;
    for _ in ids {
        let found = objects.next().await?;
        if tx.send(Ok(frame(&found)?.into())).await.is_err()
            || !send_bytes(&mut objects.stdout, found.size, tx).await?
        {
            break;
        }
        objects.end().await?;
    }
    objects.close().await;
    Ok(())
}

/// `ids` as frames, a push's own (`framed` in repo-pack-copy.ts): a kind, the 20-byte id, a
/// 4-byte length and the content.
pub(crate) fn frames_body(repo: PathBuf, ids: Arc<Vec<ObjectId>>, from: usize) -> axum::body::Body {
    let (tx, rx) = mpsc::channel(16);
    tokio::spawn(async move {
        let rest = ids.get(from..).unwrap_or_default();
        if let Err(e) = send_frames(&repo, rest, &tx).await {
            let _ = tx.send(Err(std::io::Error::other(e.message))).await;
        }
    });
    channel_body(rx)
}

/// The file at `path` as a body.
pub(crate) fn file_body(path: PathBuf) -> axum::body::Body {
    let (tx, rx) = mpsc::channel(16);
    tokio::spawn(async move {
        let sent = async {
            let mut file = tokio::fs::File::open(&path).await.map_err(err)?;
            let size = file.metadata().await.map_err(err)?.len();
            send_bytes(&mut file, size, &tx).await.map(|_| ())
        };
        if let Err(e) = sent.await {
            let _ = tx.send(Err(std::io::Error::other(e.message))).await;
        }
    });
    channel_body(rx)
}
