//! Stock Git for a clone, run as a check's command is: a scrubbed environment, the
//! unprivileged UID, its own process group, and nothing read from any configuration. The
//! clone is bare, so nothing is checked out; it has no template, so it has no hooks, and
//! `core.hooksPath` says the same again; it follows no redirect and asks for no credential.
//! One may be given: it reaches Git by environment alone, for this one command, and is
//! taken out of anything Git says.
use crate::err;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use yoneda_core::{Error, Result};

/// What is kept of what Git said when it failed.
const SAID_BYTES: usize = 2048;
/// How often a running clone's size and time are looked at.
const WATCH: Duration = Duration::from_millis(250);

/// What a clone may take.
pub(crate) struct Limits {
    pub pack_bytes: u64,
    pub time: Duration,
}

/// A private remote's password, as Git sends it; for a public one, none.
#[derive(Clone, Default)]
pub struct Credential(Option<String>);

impl Credential {
    pub(crate) fn new(secret: Option<String>) -> Self {
        Self(secret.filter(|s| !s.is_empty()))
    }

    /// The environment that has Git send it, read by no one but that Git.
    fn apply(&self, git: &mut Command) {
        let Some(secret) = &self.0 else { return };
        let basic = STANDARD.encode(format!("x-access-token:{secret}"));
        git.env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.extraHeader")
            .env(
                "GIT_CONFIG_VALUE_0",
                format!("Authorization: Basic {basic}"),
            );
    }

    /// `said` with the credential taken out.
    fn scrub(&self, said: String) -> String {
        match &self.0 {
            Some(secret) => said.replace(secret.as_str(), "<credential>"),
            None => said,
        }
    }
}

/// `git` in `dir`, knowing nothing but what it is told here.
pub(crate) fn git(dir: &Path) -> Command {
    let mut git = Command::new("git");
    git.current_dir(dir)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", dir)
        .env("LANG", "C.UTF-8")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["-c", "core.hooksPath=/dev/null"])
        .args(["-c", "credential.helper="])
        .args(["-c", "http.followRedirects=false"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    git.process_group(0);
    #[cfg(target_os = "linux")]
    {
        if unsafe { libc::geteuid() } == 0 {
            git.uid(1000).gid(1000);
        }
        // SAFETY: helper uses only async-signal-safe capability/prctl syscalls before exec.
        unsafe {
            git.pre_exec(crate::process_privileges::restrict_untrusted);
        }
    }
    git
}

/// Keeps the end of a stream, so that a chatty child never blocks on a full pipe.
fn tail(child: &mut Child) -> tokio::task::JoinHandle<Vec<u8>> {
    let stderr = child.stderr.take();
    tokio::spawn(async move {
        let mut kept = Vec::new();
        let Some(mut stderr) = stderr else {
            return kept;
        };
        let mut buffer = [0u8; 4096];
        while let Ok(count) = stderr.read(&mut buffer).await {
            if count == 0 {
                break;
            }
            kept.extend_from_slice(&buffer[..count]);
            let excess = kept.len().saturating_sub(SAID_BYTES);
            kept.drain(..excess);
        }
        kept
    })
}

/// Kills `child` and whatever it started, which could otherwise run on with the internet.
async fn kill(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|p| i32::try_from(p).ok()) {
        // SAFETY: a plain signal to the process group this child leads.
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
}

fn failed(what: &str, said: &[u8]) -> Error {
    let said = String::from_utf8_lossy(said);
    Error::new("GIT_FAILED", format!("{what}: {}", said.trim()))
}

pub(crate) fn too_large(limit: u64) -> Error {
    Error::new(
        "REPO_TOO_LARGE",
        format!(
            "This repository's history is over {:.1} GB, more than a repository can hold.",
            limit as f64 / 1e9
        ),
    )
}

/// Why a clone failed, as Git said. A disk that ran out is the repository's size, not a fault:
/// retrying cannot mend it.
pub(crate) fn clone_failed(said: &str) -> Error {
    if said.contains("No space left on device") {
        return Error::new(
            "REPO_TOO_LARGE",
            "This repository needs more disk than an import has.",
        );
    }
    failed("git clone", said.as_bytes())
}

/// The pack bytes held under `repo`, as they arrive or once kept.
fn pack_bytes(repo: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(repo.join("objects/pack")) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("tmp_pack") || name.ends_with(".pack")
        })
        .filter_map(|entry| entry.metadata().ok())
        .map(|held| held.len())
        .sum()
}

/// Clones all of `url`'s branches and tags bare into `root`, and nothing else a remote keeps
/// (a pull request's refs). `protocol` is the only one Git may use.
pub(crate) async fn bare_clone(
    root: &Path,
    url: &str,
    protocol: &str,
    credential: &Credential,
    limits: &Limits,
) -> Result<PathBuf> {
    let repo = root.join("repo.git");
    let mut clone = git(root);
    clone
        .env("GIT_ALLOW_PROTOCOL", protocol)
        .args(["clone", "--quiet", "--bare", "--template=", "--"])
        .arg(url)
        .arg(&repo);
    credential.apply(&mut clone);
    let mut process = clone.spawn().map_err(err)?;
    let said = tail(&mut process);
    let started = Instant::now();
    let status = loop {
        tokio::select! {
            status = process.wait() => break status.map_err(err)?,
            () = tokio::time::sleep(WATCH) => {
                let late = started.elapsed() >= limits.time;
                if late || pack_bytes(&repo) > limits.pack_bytes {
                    kill(&mut process).await;
                    said.abort();
                    return Err(if late {
                        Error::new("TIME_LIMIT", "The clone took too long")
                    } else {
                        too_large(limits.pack_bytes)
                    });
                }
            }
        }
    };
    let said = said.await.map_err(err)?;
    if !status.success() {
        let said = credential.scrub(String::from_utf8_lossy(&said).into_owned());
        return Err(clone_failed(&said));
    }
    if pack_bytes(&repo) > limits.pack_bytes {
        return Err(too_large(limits.pack_bytes));
    }
    Ok(repo)
}

/// The one pack a fresh clone holds.
pub(crate) fn only_pack(repo: &Path) -> Result<PathBuf> {
    let mut packs = std::fs::read_dir(repo.join("objects/pack"))
        .map_err(err)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|e| e == "pack"));
    match (packs.next(), packs.next()) {
        (Some(pack), None) => Ok(pack),
        (None, _) => Err(failed("git clone", b"The remote has no commits")),
        _ => Err(failed("git clone", b"The clone holds more than one pack")),
    }
}

/// What `git args` printed, given `input`.
pub(crate) async fn output(repo: &Path, args: &[&str], input: Vec<u8>) -> Result<Vec<u8>> {
    let mut command = git(repo);
    command.args(args).stdin(Stdio::piped());
    let mut process = command.spawn().map_err(err)?;
    let feeding = feed(&mut process, input);
    let done = process.wait_with_output().await.map_err(err)?;
    feeding.await.map_err(err)?;
    if !done.status.success() {
        return Err(failed(&format!("git {}", args[0]), &done.stderr));
    }
    Ok(done.stdout)
}

/// Writes `input` to `child` beside whatever reads it, so that neither waits on the other.
pub(crate) fn feed(child: &mut Child, input: Vec<u8>) -> tokio::task::JoinHandle<()> {
    let stdin = child.stdin.take();
    tokio::spawn(async move {
        let Some(mut stdin) = stdin else {
            return;
        };
        // A reader that stopped reading answers for itself.
        if let Err(e) = stdin.write_all(&input).await
            && e.kind() != ErrorKind::BrokenPipe
        {
            tracing::warn!(event = "clone.feed_failed", error = %e);
        }
    })
}
