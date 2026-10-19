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

fn invalid(message: impl Into<String>) -> Error {
    Error::new("INVALID_INPUT", message)
}

/// Writes the commit's files under `root`. Paths are validated like any untrusted
/// archive: no absolute paths, `..`, `.git` or duplicate entries.
pub fn materialize(root: &Path, files: &[CheckFile]) -> Result<()> {
    if files.len() > MAX_FILES {
        return Err(invalid("Too many files for a check"));
    }
    let mut total = 0usize;
    let mut seen = std::collections::HashSet::new();
    for file in files {
        yoneda_core::validate_path(&file.path)?;
        if !seen.insert(file.path.as_str()) {
            return Err(invalid(format!("{} appears twice", file.path)));
        }
        let data = STANDARD
            .decode(&file.data_b64)
            .map_err(|_| invalid("File content is not base64"))?;
        total += data.len();
        if total > MAX_BYTES {
            return Err(invalid("Check files exceed the size limit"));
        }
        let target = root.join(&file.path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        match file.kind.as_str() {
            "blob" | "exec" => {
                std::fs::write(&target, &data).map_err(err)?;
                #[cfg(unix)]
                if file.kind == "exec" {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                        .map_err(err)?;
                }
            }
            #[cfg(unix)]
            "symlink" => {
                let link =
                    String::from_utf8(data).map_err(|_| invalid("Symlink target is not UTF-8"))?;
                std::os::unix::fs::symlink(link, &target).map_err(err)?;
            }
            other => return Err(invalid(format!("Unsupported entry type {other}"))),
        }
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
            format!("{:x}", hash.finalize()),
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

/// Materializes and runs one check in a fresh temporary directory.
pub async fn run(request: CheckRequest) -> Result<Value> {
    if !(1..=3600).contains(&request.timeout_seconds) {
        return Err(invalid("timeout_seconds must be 1-3600"));
    }
    let dir = tempfile::Builder::new()
        .prefix("check-")
        .tempdir_in(
            std::env::var_os("YONEDA_CHECK_ROOT")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir),
        )
        .map_err(err)?;
    materialize(dir.path(), &request.files)?;
    execute(
        dir.path(),
        &request.command,
        Duration::from_secs(request.timeout_seconds),
    )
    .await
}
