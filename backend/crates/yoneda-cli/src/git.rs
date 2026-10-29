//! The local repository, through the `git` executable: plumbing only, so a person's own
//! Git configuration and hooks never change what is synced.
use crate::error::{Context, Error, Result};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Identity of the commits this client makes for platform snapshots.
const SNAPSHOT_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "YonedaRepo"),
    ("GIT_AUTHOR_EMAIL", "commits@yonedarepo.invalid"),
    ("GIT_COMMITTER_NAME", "YonedaRepo"),
    ("GIT_COMMITTER_EMAIL", "commits@yonedarepo.invalid"),
];

pub struct Git {
    dir: PathBuf,
    /// An explicit repository (the remote helper gets `GIT_DIR`, maybe bare).
    git_dir: Option<PathBuf>,
}

/// A local commit's author and message.
pub struct Authored {
    pub name: String,
    pub email: String,
    pub message: String,
}

impl Git {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            git_dir: None,
        }
    }

    /// The repository at `git_dir` (absolute), run from `dir`.
    pub fn with_git_dir(dir: impl Into<PathBuf>, git_dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            git_dir: Some(git_dir.into()),
        }
    }

    /// Whether `ancestor` is reachable from (or equal to) `commit`.
    pub fn is_ancestor(&self, ancestor: &str, commit: &str) -> bool {
        self.succeeds(&["merge-base", "--is-ancestor", ancestor, commit])
    }

    /// The commit `spec` names.
    pub fn commit_of(&self, spec: &str) -> Result<String> {
        self.run(&["rev-parse", "--verify", "-q", &format!("{spec}^{{commit}}")])
    }

    /// The work tree containing `cwd`.
    pub fn toplevel(cwd: &Path) -> Result<PathBuf> {
        let git = Git::new(cwd);
        Ok(PathBuf::from(git.run(&["rev-parse", "--show-toplevel"])?))
    }

    fn command(&self, envs: &[(&str, &str)]) -> Command {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(&self.dir)
            .args(
                self.git_dir
                    .iter()
                    .flat_map(|d| [OsStr::new("--git-dir"), d.as_os_str()]),
            )
            .env("GIT_TERMINAL_PROMPT", "0")
            .envs(envs.iter().copied());
        command
    }

    /// Runs git with optional stdin; returns stdout, or an error with git's stderr.
    pub fn output(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        envs: &[(&str, &str)],
    ) -> Result<Vec<u8>> {
        let mut child = self
            .command(envs)
            .args(args)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("running git (is it installed?)")?;
        // The input is written from its own thread while stdout and stderr are drained
        // here: written first, a large request (cat-file --batch-check ids) fills the
        // child's stdout pipe, the child stops reading, and both sides wait forever.
        let writer = match (input, child.stdin.take()) {
            (Some(bytes), Some(mut stdin)) => {
                let bytes = bytes.to_vec();
                Some(std::thread::spawn(move || stdin.write_all(&bytes)))
            }
            _ => None,
        };
        let out = child
            .wait_with_output()
            .context(format!("waiting for git {}", args[0]))?;
        let written = match writer.map(std::thread::JoinHandle::join) {
            None => Ok(()),
            Some(Ok(result)) => result,
            Some(Err(_)) => return Err(Error::new(format!("writing to git {} panicked", args[0]))),
        };
        if !out.status.success() {
            return Err(Error::new(format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        // A child that succeeded without reading all its input closed the pipe on purpose.
        match written {
            Err(e) if e.kind() != std::io::ErrorKind::BrokenPipe => {
                Err(Error::new(format!("writing to git {}: {e}", args[0])))
            }
            _ => Ok(out.stdout),
        }
    }

    pub fn run(&self, args: &[&str]) -> Result<String> {
        let out = self.output(args, None, &[])?;
        Ok(String::from_utf8_lossy(&out).trim().to_owned())
    }

    pub fn succeeds(&self, args: &[&str]) -> bool {
        self.command(&[])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    /// Commits on HEAD's first-parent chain after `base`, oldest first.
    pub fn first_parent_since(&self, base: &str) -> Result<Vec<String>> {
        if !self.succeeds(&["merge-base", "--is-ancestor", base, "HEAD"]) {
            return Err(Error::new(format!(
                "HEAD does not contain the synced base {base}; run `yoneda pull` or restore it"
            )));
        }
        let range = format!("{base}..HEAD");
        let listed = self.run(&["rev-list", "--first-parent", "--reverse", &range])?;
        Ok(listed.lines().map(str::to_owned).collect())
    }

    pub fn tree_of(&self, commit: &str) -> Result<String> {
        self.run(&["rev-parse", &format!("{commit}^{{tree}}")])
    }

    pub fn first_parent(&self, commit: &str) -> Result<String> {
        self.run(&["rev-parse", &format!("{commit}^1")])
    }

    /// `commit`'s first parent, or `None` for a root commit.
    pub fn first_parent_of(&self, commit: &str) -> Result<Option<String>> {
        let line = self.run(&["rev-list", "--parents", "-n", "1", commit])?;
        Ok(line.split_whitespace().nth(1).map(str::to_owned))
    }

    pub fn authored(&self, commit: &str) -> Result<Authored> {
        let raw = self.output(
            &["log", "-1", "--format=%an%x00%ae%x00%B", commit],
            None,
            &[],
        )?;
        let text = String::from_utf8_lossy(&raw);
        let mut parts = text.splitn(3, '\0');
        let (Some(name), Some(email), Some(message)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(Error::new(format!("cannot read the author of {commit}")));
        };
        Ok(Authored {
            name: name.to_owned(),
            email: email.to_owned(),
            message: message.trim_end().to_owned(),
        })
    }

    /// Object contents by id, through one `git cat-file --batch`.
    pub fn read_blobs(&self, ids: &[String]) -> Result<HashMap<String, Vec<u8>>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut child = self
            .command(&[])
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("running git cat-file")?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::new("git cat-file stdin"))?;
        let request = ids.iter().map(|id| format!("{id}\n")).collect::<String>();
        // A writer thread keeps a large request from deadlocking against the output.
        let writer = std::thread::spawn(move || stdin.write_all(request.as_bytes()));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::new("git cat-file stdout"))?;
        let mut reader = BufReader::new(stdout);
        let mut blobs = HashMap::new();
        for id in ids {
            let mut header = String::new();
            reader
                .read_line(&mut header)
                .context("reading git cat-file")?;
            let size = match header.split_whitespace().collect::<Vec<_>>()[..] {
                [_, "blob", size] => size.parse::<usize>().context("git cat-file size")?,
                _ => {
                    return Err(Error::new(format!(
                        "{id} is not a blob in the local repository"
                    )));
                }
            };
            let mut data = vec![0; size + 1];
            reader
                .read_exact(&mut data)
                .context("reading git cat-file")?;
            data.truncate(size);
            blobs.insert(id.clone(), data);
        }
        writer
            .join()
            .map_err(|_| Error::new("git cat-file writer panicked"))?
            .context("writing to git cat-file")?;
        child.wait().context("waiting for git cat-file")?;
        Ok(blobs)
    }

    /// The ids among `ids` that the local object database does not hold.
    pub fn missing(&self, ids: &[String]) -> Result<Vec<String>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let request = ids.iter().map(|id| format!("{id}\n")).collect::<String>();
        let out = self.output(
            &["cat-file", "--batch-check"],
            Some(request.as_bytes()),
            &[],
        )?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|line| line.strip_suffix(" missing").map(str::to_owned))
            .collect())
    }

    /// Adds a pack to the local object database (`git index-pack` verifies every
    /// object and writes the pack with its index).
    pub fn unpack(&self, pack: &[u8]) -> Result<()> {
        self.output(&["index-pack", "--stdin"], Some(pack), &[])
            .map(|_| ())
    }

    /// A commit of `tree` on `parent`, with the snapshot identity.
    pub fn commit_tree(&self, tree: &str, parent: Option<&str>, message: &str) -> Result<String> {
        let mut args = vec!["commit-tree", tree];
        if let Some(parent) = parent {
            args.extend(["-p", parent]);
        }
        let out = self.output(&args, Some(message.as_bytes()), &SNAPSHOT_IDENTITY)?;
        Ok(String::from_utf8_lossy(&out).trim().to_owned())
    }

    /// The tree of `commit` with `index_info` (`git update-index -z --index-info`
    /// records) applied, built in a private index so the person's index is untouched.
    pub fn tree_with(&self, commit: &str, index_info: &[u8]) -> Result<String> {
        let name = format!("yoneda-index-{}", std::process::id());
        let path = self.run(&["rev-parse", "--git-path", &name])?;
        let path = self.dir.join(path);
        let index = path.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", index.as_str())];
        let built = self
            .output(&["read-tree", commit], None, &env)
            .and_then(|_| {
                self.output(
                    &["update-index", "-z", "--index-info"],
                    Some(index_info),
                    &env,
                )
            })
            .and_then(|_| self.output(&["write-tree"], None, &env));
        let _ = std::fs::remove_file(&path);
        Ok(String::from_utf8_lossy(&built?).trim().to_owned())
    }

    /// Whether the work tree and index match HEAD (ignored files aside).
    pub fn clean(&self) -> Result<bool> {
        Ok(self
            .run(&["status", "--porcelain", "--untracked-files=no"])?
            .is_empty())
    }
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod tests;
