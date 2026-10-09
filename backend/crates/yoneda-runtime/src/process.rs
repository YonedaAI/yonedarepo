use crate::{broker::broker_url, err};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio};
use tokio::process::Command;
use yoneda_core::Result;
pub(crate) fn untrusted(command: &mut Command, root: &Path) {
    command
        .current_dir(root)
        .env_clear()
        .env("PATH", "/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin")
        .env("HOME", "/home/agent")
        .env("CARGO_HOME", "/home/agent/.cargo")
        .env("RUSTUP_HOME", "/usr/local/rustup")
        .env("CARGO_TARGET_DIR", "/work/target")
        .env("YONEDA_BROKER", broker_url(""))
        .env("CODEX_HOME", "/home/agent/.codex")
        .env("ANTHROPIC_BASE_URL", "http://claude.yoneda.internal")
        .env("ANTHROPIC_API_KEY", "scoped-container-proxy")
        .env("DISABLE_NON_ESSENTIAL_MODEL_CALLS", "1")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        // Match the proxy ceiling so Claude does not attempt 32K tool writes and
        // repeatedly continue a response that the upstream can only return at 4K.
        .env("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "4096")
        .env("CLAUDE_CODE_EFFORT_LEVEL", "low")
        .env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
    #[cfg(target_os = "linux")]
    {
        // The deployed supervisor requires root before accepting jobs. Native
        // helper tests also run as an ordinary Linux user, which cannot set UID.
        if unsafe { libc::geteuid() } == 0 {
            command.uid(1000).gid(1000);
        }
        // SAFETY: only async-signal-safe prctl runs in the forked child, before exec.
        unsafe {
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command.kill_on_drop(true);
}

pub(crate) async fn bounded_output(command: &mut Command) -> Result<Value> {
    use tokio::io::AsyncReadExt;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut processes = crate::process_guard::AgentProcesses::prepare()?;
    let mut child = command.spawn().map_err(err)?;
    #[cfg(unix)]
    let _group = ProcessGroup(child.id().ok_or_else(|| err("Child has no process ID"))? as i32);
    async fn read(mut stream: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
        let mut output = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let count = stream.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            let keep = count.min((2 * 1024 * 1024usize).saturating_sub(output.len()));
            output.extend_from_slice(&buffer[..keep]);
        }
        Ok(output)
    }
    let out = child.stdout.take().unwrap();
    let errors = child.stderr.take().unwrap();
    let (out, errors, status) = tokio::join!(read(out), read(errors), child.wait());
    #[cfg(unix)]
    drop(_group);
    processes.finish()?;
    Ok(
        json!({"exit":status.map_err(err)?.code().unwrap_or(-1),"stdout":String::from_utf8_lossy(&out.map_err(err)?),"stderr":String::from_utf8_lossy(&errors.map_err(err)?)}),
    )
}

// Dropping the future on timeout also stops descendants that outlive their CLI parent.
#[cfg(unix)]
struct ProcessGroup(i32);
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // SAFETY: the child was spawned into its own group; negative PID targets that group.
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
}
