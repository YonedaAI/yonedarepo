//! Run a check in an owned process group and fence its descendants on timeout.
//! All termination targets are the PID or container started by this invocation.
use crate::layout::local_error;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use yoneda_core::Result;
const TAIL_BYTES: usize = 2048;

/// Runs `command` in `dir` in its own process group; `None` exit code: it timed out and
/// was stopped (the group by its recorded id, a container by its run name).
pub fn run(
    command: &[String],
    dir: &Path,
    timeout: u64,
    container: Option<&String>,
) -> Result<(Option<i32>, String)> {
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    let (program, args) = command
        .split_first()
        .ok_or_else(|| local_error("The check has no command"))?;
    let log = dir.with_extension("log");
    let out = std::fs::File::create(&log).map_err(|e| local_error(format!("No check log: {e}")))?;
    let err = out
        .try_clone()
        .map_err(|e| local_error(format!("No check log: {e}")))?;
    let mut launch = Command::new(program);
    launch
        .args(args)
        .current_dir(dir)
        .env_remove("YONEDA_TOKEN")
        .env_remove("YONEDA_LOCAL_TIMINGS")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    #[cfg(unix)]
    launch.process_group(0);
    #[cfg(windows)]
    launch.creation_flags(0x0000_0200);
    let mut child = launch
        .spawn()
        .map_err(|e| local_error(format!("Cannot start {program}: {e}")))?;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.code().unwrap_or(-1)),
            Ok(None) if Instant::now() >= deadline => {
                if let Some(name) = container {
                    let _ = Command::new("docker")
                        .args(["kill", &format!("yoneda-check-{name}")])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
                #[cfg(unix)]
                let _ = Command::new("kill")
                    .args(["-KILL", &format!("-{}", child.id())])
                    .stderr(Stdio::null())
                    .status();
                #[cfg(windows)]
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                #[cfg(not(any(unix, windows)))]
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(local_error(format!("The check was lost: {e}"))),
        }
    };
    let bytes = std::fs::read(&log).unwrap_or_default();
    let _ = std::fs::remove_file(&log);
    let tail =
        String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(TAIL_BYTES)..]).into_owned();
    Ok((code, tail))
}
