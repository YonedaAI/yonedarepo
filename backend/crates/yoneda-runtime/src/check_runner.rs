//! Platform check executor (`yoneda-runtime check-server`). The Worker sends the exact
//! commit's files and the policy's argv; this materializes them in a fresh directory,
//! runs the command as the unprivileged UID without credentials or network, and returns
//! bounded evidence. It never talks to the platform itself: the Worker records results.
use crate::err;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use yoneda_core::{Error, Result};

const MAX_FILES: usize = 100_000;
const MAX_BYTES: usize = 192 * 1024 * 1024;
const TAIL_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckFile {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub data_b64: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckRequest {
    pub command: Vec<String>,
    pub timeout_seconds: u64,
    pub files: Vec<CheckFile>,
}

pub(crate) fn invalid(message: impl Into<String>) -> Error {
    Error::new("INVALID_INPUT", message)
}

/// The kind of a check file's entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Blob,
    Exec,
    Symlink,
}

impl EntryKind {
    fn parse(kind: &str) -> Result<EntryKind> {
        match kind {
            "blob" => Ok(EntryKind::Blob),
            "exec" => Ok(EntryKind::Exec),
            "symlink" => Ok(EntryKind::Symlink),
            other => Err(invalid(format!("Unsupported entry type {other}"))),
        }
    }
}

/// Writes a commit's files under `root`, one at a time as they arrive. Paths are validated
/// like any untrusted archive: no absolute paths, `..`, `.git` or duplicate entries.
/// Symlink targets stay inside `root`, and no written path may pass through a symlink an
/// earlier entry planted. The file count and total size are bounded.
pub struct Materializer<'a> {
    root: &'a Path,
    total: usize,
    seen: std::collections::HashSet<String>,
}

impl<'a> Materializer<'a> {
    pub fn new(root: &'a Path) -> Self {
        Materializer {
            root,
            total: 0,
            seen: std::collections::HashSet::new(),
        }
    }

    /// Files written so far.
    pub fn files(&self) -> usize {
        self.seen.len()
    }

    /// Bytes written so far.
    pub fn bytes(&self) -> usize {
        self.total
    }

    /// Whether `more` bytes would pass the size limit (checked before they are read).
    pub fn would_exceed(&self, more: usize) -> bool {
        self.total.saturating_add(more) > MAX_BYTES
    }

    pub fn write(&mut self, path: &str, kind: EntryKind, data: &[u8]) -> Result<()> {
        if self.seen.len() >= MAX_FILES {
            return Err(invalid("Too many files for a check"));
        }
        yoneda_core::validate_path(path)?;
        if !self.seen.insert(path.to_owned()) {
            return Err(invalid(format!("{path} appears twice")));
        }
        if self.would_exceed(data.len()) {
            return Err(invalid("Check files exceed the size limit"));
        }
        self.total += data.len();
        let root = self.root;
        let target = root.join(path);
        let mut at = root.to_path_buf();
        for component in Path::new(path).parent().unwrap_or(Path::new("")) {
            at.push(component);
            if std::fs::symlink_metadata(&at)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err(invalid(format!(
                    "{path} passes through the symlink {component:?}"
                )));
            }
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        match kind {
            EntryKind::Blob | EntryKind::Exec => {
                std::fs::write(&target, data).map_err(err)?;
                #[cfg(unix)]
                if kind == EntryKind::Exec {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                        .map_err(err)?;
                }
            }
            #[cfg(unix)]
            EntryKind::Symlink => {
                let link = std::str::from_utf8(data)
                    .map_err(|_| invalid("Symlink target is not UTF-8"))?;
                if !yoneda_core::symlink_stays_inside(path, link) {
                    return Err(invalid(format!(
                        "Symlink target escapes the check root: {link:?}"
                    )));
                }
                std::os::unix::fs::symlink(link, &target).map_err(err)?;
            }
            #[cfg(not(unix))]
            EntryKind::Symlink => return Err(invalid("Symlinks need a Unix check executor")),
        }
        Ok(())
    }
}

/// Writes the commit's files (the JSON request's base64 form) under `root`.
pub fn materialize(root: &Path, files: &[CheckFile]) -> Result<()> {
    if files.len() > MAX_FILES {
        return Err(invalid("Too many files for a check"));
    }
    let mut out = Materializer::new(root);
    for file in files {
        let data = STANDARD
            .decode(&file.data_b64)
            .map_err(|_| invalid("File content is not base64"))?;
        out.write(&file.path, EntryKind::parse(&file.kind)?, &data)?;
    }
    Ok(())
}

/// Hands the materialized tree to the unprivileged check UID (deployed: runtime is root).
fn hand_over(root: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    if unsafe { libc::geteuid() } == 0 {
        for entry in walkdir::WalkDir::new(root) {
            let entry = entry.map_err(err)?;
            std::os::unix::fs::lchown(entry.path(), Some(1000), Some(1000)).map_err(err)?;
        }
    }
    let _ = root;
    Ok(())
}

/// Runs argv in `root` with a scrubbed environment and a hard timeout that kills the
/// whole process group. Output is hashed in full and kept as a bounded tail.
pub async fn execute(root: &Path, command: &[String], timeout: Duration) -> Result<Value> {
    let (program, args) = command
        .split_first()
        .ok_or_else(|| invalid("Empty check command"))?;
    hand_over(root)?;
    let mut child = tokio::process::Command::new(program);
    child
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("PATH", "/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin")
        .env("HOME", "/home/agent")
        .env("CARGO_HOME", "/home/agent/.cargo")
        .env("RUSTUP_HOME", "/usr/local/rustup")
        .env("CI", "true")
        .env("LANG", "C.UTF-8")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    child.process_group(0);
    #[cfg(target_os = "linux")]
    {
        if unsafe { libc::geteuid() } == 0 {
            child.uid(1000).gid(1000);
        }
        // SAFETY: helper uses only async-signal-safe capability/prctl syscalls before exec.
        unsafe {
            child.pre_exec(crate::process_privileges::restrict_untrusted);
        }
    }
    let started = Instant::now();
    let mut process = child
        .spawn()
        .map_err(|e| Error::new("CHECK_START", format!("Cannot start {program}: {e}")))?;
    let group = process.id();
    let (Some(stdout), Some(stderr)) = (process.stdout.take(), process.stderr.take()) else {
        return Err(err("Missing check output pipes"));
    };
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let forward = |mut stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
                   sender: tokio::sync::mpsc::Sender<Vec<u8>>| async move {
        let mut buffer = vec![0u8; 16 * 1024];
        while let Ok(count) = stream.read(&mut buffer).await {
            if count == 0 || sender.send(buffer[..count].to_vec()).await.is_err() {
                break;
            }
        }
    };
    let out = tokio::spawn(forward(Box::new(stdout), sender.clone()));
    let errs = tokio::spawn(forward(Box::new(stderr), sender));
    let collect = tokio::spawn(async move {
        let mut hash = Sha256::new();
        let mut tail: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
        let mut total = 0u64;
        while let Some(chunk) = receiver.recv().await {
            hash.update(&chunk);
            total += chunk.len() as u64;
            tail.extend(chunk);
            let excess = tail.len().saturating_sub(TAIL_BYTES);
            tail.drain(..excess);
        }
        (
            yoneda_core::hex(&hash.finalize()),
            total,
            tail.into_iter().collect::<Vec<u8>>(),
        )
    });
    let waited = tokio::time::timeout(timeout, process.wait()).await;
    let timed_out = waited.is_err();
    #[cfg(unix)]
    if let Some(pid) = group.and_then(|p| i32::try_from(p).ok()) {
        // Stop descendants too; they could otherwise hold the output pipes open.
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
    }
    let status = match waited {
        Ok(status) => Some(status.map_err(err)?),
        Err(_) => {
            let _ = process.kill().await;
            None
        }
    };
    let _ = tokio::join!(out, errs);
    let (sha256, bytes, tail) = collect.await.map_err(err)?;
    let exit_code = status.and_then(|s| s.code());
    let passed = !timed_out && exit_code == Some(0);
    Ok(json!({
        "outcome": if passed { "pass" } else { "fail" },
        "exit_code": exit_code,
        "timed_out": timed_out,
        "duration_ms": started.elapsed().as_millis() as u64,
        "output_bytes": bytes,
        "output_sha256": sha256,
        "output_tail": String::from_utf8_lossy(&tail),
    }))
}

/// A fresh temporary directory for one check.
pub fn check_dir() -> Result<tempfile::TempDir> {
    tempfile::Builder::new()
        .prefix("check-")
        .tempdir_in(
            std::env::var_os("YONEDA_CHECK_ROOT")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir),
        )
        .map_err(err)
}

pub fn valid_timeout(timeout_seconds: u64) -> Result<Duration> {
    if !(1..=3600).contains(&timeout_seconds) {
        return Err(invalid("timeout_seconds must be 1-3600"));
    }
    Ok(Duration::from_secs(timeout_seconds))
}

/// Materializes and runs one check in a fresh temporary directory. `setup_ms` (in the
/// result) is the time from the request's arrival to its files written: what a check pays
/// before its command starts.
pub async fn run(request: CheckRequest, arrived: Instant) -> Result<Value> {
    let timeout = valid_timeout(request.timeout_seconds)?;
    let dir = check_dir()?;
    materialize(dir.path(), &request.files)?;
    let setup_ms = since(arrived);
    let mut result = execute(dir.path(), &request.command, timeout).await?;
    result["setup_ms"] = json!(setup_ms);
    Ok(result)
}

/// Milliseconds since `at`.
pub fn since(at: Instant) -> u64 {
    u64::try_from(at.elapsed().as_millis()).unwrap_or(u64::MAX)
}
