//! A cloned repository's commits as a push records them (`repo_record_pushed`): every commit
//! of every branch and tag, parents first, each with its bytes and its file-level changes
//! against its first parent (`git diff-tree -r --no-renames`, so a rename is its delete and
//! add). Nothing is held between calls but which commit follows which.
use crate::clone_git::{feed, git, output};
use crate::clone_read::{Objects, bad};
use crate::err;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdout};
use yoneda_core::Result;
use yoneda_core::git_object::{FileMode, ObjectId};
use yoneda_core::txlog::{PathOp, PathTouch};

/// Changed files a commit records, the authority's `TOUCHES`. Past it, a commit lists none:
/// its files are all there, and only a path's history skips it.
const MAX_FILES: usize = 100_000;
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/// `<old tree> <new tree>\n`, as `diff-tree --stdin` opens each commit.
const PAIR_BYTES: usize = 82;

/// One commit, with the tree its changes are read against.
#[derive(Clone, Copy)]
pub(crate) struct Link {
    id: ObjectId,
    tree: ObjectId,
    old: Option<ObjectId>,
}

/// Every commit the clone's refs reach, parents before children.
pub(crate) async fn all_commits(repo: &Path) -> Result<Vec<Link>> {
    let args = [
        "log",
        "--all",
        "--topo-order",
        "--reverse",
        "--no-show-signature",
        "--format=%H %T %P",
    ];
    let listed = String::from_utf8_lossy(&output(repo, &args, Vec::new()).await?).into_owned();
    let mut trees: HashMap<ObjectId, ObjectId> = HashMap::new();
    let mut links = Vec::new();
    for line in listed.lines() {
        let mut fields = line.split(' ').filter(|f| !f.is_empty());
        let (Some(id), Some(tree)) = (fields.next(), fields.next()) else {
            return Err(bad(format!("Unreadable commit {line}")));
        };
        let (id, tree) = (ObjectId::parse(id)?, ObjectId::parse(tree)?);
        let old = match fields.next() {
            Some(parent) => Some(
                *trees
                    .get(&ObjectId::parse(parent)?)
                    .ok_or_else(|| bad(format!("A parent of {id} comes after it")))?,
            ),
            None => None,
        };
        trees.insert(id, tree);
        links.push(Link { id, tree, old });
    }
    Ok(links)
}

/// A commit's changes as they arrive: none kept past the limit.
#[derive(Default)]
struct Changes {
    touches: Vec<PathTouch>,
    over: bool,
}

impl Changes {
    fn add(&mut self, touch: PathTouch) {
        if self.touches.len() >= MAX_FILES {
            self.over = true;
            self.touches = Vec::new();
        } else if !self.over {
            self.touches.push(touch);
        }
    }

    fn finish(mut self) -> Vec<PathTouch> {
        self.touches.sort_by(|a, b| a.path.cmp(&b.path));
        self.touches
    }
}

const NO_MODE: &str = "000000";
const NO_ID: &str = "0000000000000000000000000000000000000000";

fn file_mode(mode: &str) -> FileMode {
    match mode {
        "120000" => FileMode::Symlink,
        "160000" => FileMode::Gitlink,
        "100755" => FileMode::Executable,
        _ => FileMode::Blob,
    }
}

/// `:<old mode> <new mode> <old id> <new id> <status>`, and its path, as `touch` says it.
fn touch(raw: &str, path: String) -> Result<PathTouch> {
    let mut fields = raw.trim_start_matches(':').split(' ');
    let (Some(old_mode), Some(new_mode), Some(old), Some(new)) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return Err(bad(format!("Unreadable change {raw}")));
    };
    let id = |mode: &str, id: &str| {
        (mode != NO_MODE && id != NO_ID)
            .then(|| ObjectId::parse(id))
            .transpose()
    };
    let (old_blob, new_blob) = (id(old_mode, old)?, id(new_mode, new)?);
    let mode = (new_mode != NO_MODE)
        .then(|| file_mode(new_mode))
        .filter(|mode| *mode != FileMode::Gitlink);
    Ok(PathTouch {
        path,
        op: match (old_blob, new_blob) {
            (None, _) => PathOp::Add,
            (_, None) => PathOp::Delete,
            _ => PathOp::Modify,
        },
        old_blob,
        new_blob,
        mode,
    })
}

/// Reads up to and past the next NUL; `None` at the end. The last record has no NUL.
async fn record(from: &mut (impl AsyncBufReadExt + Unpin)) -> Result<Option<Vec<u8>>> {
    let mut out = Vec::new();
    if from.read_until(0, &mut out).await.map_err(err)? == 0 {
        return Ok(None);
    }
    if out.last() == Some(&0) {
        out.pop();
    }
    Ok(Some(out))
}

/// Each pair's changes from `git diff-tree --stdin -z`, in order. A pair opens with a line of
/// its two trees, and then come NUL-ended records, status then path; a pair with no changes
/// runs straight on to the next one's line.
struct Diffs {
    process: Child,
    stdout: BufReader<ChildStdout>,
    current: Option<Changes>,
    /// What is left of a record already read.
    held: Vec<u8>,
    _feeding: tokio::task::JoinHandle<()>,
}

impl Diffs {
    fn open(repo: &Path, pairs: String) -> Result<Self> {
        let mut command = git(repo);
        command
            .args(["diff-tree", "--stdin", "-r", "--no-renames", "-z"])
            .stdin(Stdio::piped())
            .stderr(Stdio::null());
        let mut process = command.spawn().map_err(err)?;
        let feeding = feed(&mut process, pairs.into_bytes());
        let stdout = process.stdout.take().ok_or_else(|| err("No diff output"))?;
        Ok(Self {
            process,
            stdout: BufReader::new(stdout),
            current: None,
            held: Vec::new(),
            _feeding: feeding,
        })
    }

    /// The next pair's changes; `None` once Git has ended well.
    async fn next(&mut self) -> Result<Option<Changes>> {
        loop {
            if self.held.is_empty() {
                match record(&mut self.stdout).await? {
                    Some(raw) => self.held = raw,
                    None => return self.end().await,
                }
                continue;
            }
            if self.held[0] != b':' {
                if self.held.len() < PAIR_BYTES || self.held[PAIR_BYTES - 1] != b'\n' {
                    return Err(bad("Unreadable diff output"));
                }
                self.held.drain(..PAIR_BYTES);
                if let Some(done) = self.current.replace(Changes::default()) {
                    return Ok(Some(done));
                }
                continue;
            }
            let line = String::from_utf8_lossy(&self.held).into_owned();
            self.held.clear();
            let path = record(&mut self.stdout).await?;
            let path = path.ok_or_else(|| bad("A change has no path"))?;
            let path = String::from_utf8_lossy(&path).into_owned();
            let changes = self
                .current
                .as_mut()
                .ok_or_else(|| bad("A change before its commit"))?;
            // A path this platform could not serve stays in the tree, and out of the record.
            if yoneda_core::validate_path(&path).is_ok() {
                changes.add(touch(&line, path)?);
            }
        }
    }

    async fn end(&mut self) -> Result<Option<Changes>> {
        if let Some(done) = self.current.take() {
            return Ok(Some(done));
        }
        if self.process.wait().await.map_err(err)?.success() {
            Ok(None)
        } else {
            Err(bad("git diff-tree failed"))
        }
    }
}

/// `links` as `repo_record_pushed` takes them, a line each.
pub(crate) async fn commit_lines(repo: &Path, links: &[Link]) -> Result<String> {
    let pairs: String = links
        .iter()
        .map(|link| {
            let old = link.old.map(|tree| tree.hex());
            format!("{} {}\n", old.as_deref().unwrap_or(EMPTY_TREE), link.tree)
        })
        .collect();
    let ids: Vec<ObjectId> = links.iter().map(|link| link.id).collect();
    let mut objects = Objects::open(repo, &ids)?;
    let mut diffs = Diffs::open(repo, pairs)?;
    let mut lines = String::new();
    for link in links {
        let found = objects.next().await?;
        let data = objects.content(&found).await?;
        let changes = diffs
            .next()
            .await?
            .ok_or_else(|| bad("Fewer diffs than commits"))?;
        let line: Value = json!({
            "commit": link.id,
            "data_b64": STANDARD.encode(&data),
            "touches": changes.finish(),
            "objects": [{ "id": link.id, "kind": "commit" }],
            "check": false,
        });
        lines.push_str(&line.to_string());
        lines.push('\n');
    }
    objects.close().await;
    if diffs.next().await?.is_some() {
        return Err(bad("More diffs than commits"));
    }
    Ok(lines)
}
