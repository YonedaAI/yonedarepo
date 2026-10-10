use crate::{broker::broker_url, err};
use serde_json::Value;
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
    if let Some(certificates) = std::env::var_os("NODE_EXTRA_CA_CERTS") {
        command.env("NODE_EXTRA_CA_CERTS", certificates);
    }
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
    captured_output(command, &crate::agent_transcript::Transcript::default()).await
}

pub(crate) async fn captured_output(
    command: &mut Command,
    transcript: &crate::agent_transcript::Transcript,
) -> Result<Value> {
    captured_output_with_input(command, transcript, None).await
}

/// Large prompts travel through a pipe, never a Linux single-argument allocation.
pub(crate) async fn captured_output_with_input(
    command: &mut Command,
    transcript: &crate::agent_transcript::Transcript,
    input: Option<&str>,
) -> Result<Value> {
    use crate::agent_transcript::Channel;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    if input.is_some_and(|text| text.len() > crate::report::REPORT_LIMIT) {
        return Err(yoneda_core::Error::new(
            "PROMPT_LIMIT",
            "Harness prompt exceeds the 8 MiB stdin cap",
        ));
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    #[cfg(unix)]
    command.process_group(0);
    let mut processes = crate::process_guard::AgentProcesses::prepare()?;
    let mut child = command.spawn().map_err(err)?;
    #[cfg(unix)]
    let _group = ProcessGroup(
        i32::try_from(child.id().ok_or_else(|| err("Child has no process ID"))?).map_err(err)?,
    );
    async fn read(
        mut stream: impl tokio::io::AsyncRead + Unpin,
        transcript: &crate::agent_transcript::Transcript,
        channel: Channel,
    ) -> std::io::Result<()> {
        let mut buffer = [0u8; 8192];
        loop {
            let count = stream.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            transcript.append(channel, &buffer[..count])?;
        }
        Ok(())
    }
    let out = child
        .stdout
        .take()
        .ok_or_else(|| err("Missing child stdout pipe"))?;
    let errors = child
        .stderr
        .take()
        .ok_or_else(|| err("Missing child stderr pipe"))?;
    // Reap the primary child, then stop descendants before waiting for pipe EOF.
    // Background processes (including Linux setsid descendants) can hold either pipe open.
    let stdin = child.stdin.take();
    let wait = async {
        let status = child.wait().await.map_err(err)?;
        #[cfg(unix)]
        drop(_group);
        processes.finish()?;
        Ok::<_, yoneda_core::Error>(status)
    };
    let write = async {
        if let (Some(mut pipe), Some(input)) = (stdin, input) {
            pipe.write_all(input.as_bytes()).await.map_err(err)?;
            pipe.shutdown().await.map_err(err)?;
        }
        Ok::<_, yoneda_core::Error>(())
    };
    let (out, errors, status, written) = tokio::join!(
        read(out, transcript, Channel::Stdout),
        read(errors, transcript, Channel::Stderr),
        wait,
        write
    );
    let status = status.map_err(err)?;
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;
    tracing::info!(exit_code = status.code(), signal, "agent process finished");
    out.map_err(err)?;
    errors.map_err(err)?;
    written?;
    transcript.output(Some(status.code().unwrap_or(-1)), signal)
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
