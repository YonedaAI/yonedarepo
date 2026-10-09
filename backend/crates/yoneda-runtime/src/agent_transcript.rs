//! Supervisor-owned bounded memory survives cancellation of an untrusted harness future.
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use yoneda_core::Result;

pub(crate) const STREAM_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone, Default)]
pub(crate) struct Transcript(Arc<Mutex<Streams>>);

#[derive(Default)]
struct Streams {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    recorded: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum Channel {
    Stdout,
    Stderr,
}

impl Transcript {
    pub(crate) fn append(&self, channel: Channel, bytes: &[u8]) -> std::io::Result<()> {
        let mut streams = self
            .0
            .lock()
            .map_err(|_| std::io::Error::other("Transcript lock poisoned"))?;
        let Streams {
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            ..
        } = &mut *streams;
        let (output, truncated) = match channel {
            Channel::Stdout => (stdout, stdout_truncated),
            Channel::Stderr => (stderr, stderr_truncated),
        };
        let keep = bytes.len().min(STREAM_LIMIT.saturating_sub(output.len()));
        output.extend_from_slice(&bytes[..keep]);
        *truncated |= keep < bytes.len();
        Ok(())
    }

    pub(crate) fn output(&self, exit: Option<i32>, signal: Option<i32>) -> Result<Value> {
        let streams = self
            .0
            .lock()
            .map_err(|_| crate::err("Transcript lock poisoned"))?;
        Ok(json!({"exit":exit,"signal":signal,
            "stdout":String::from_utf8_lossy(&streams.stdout),
            "stderr":String::from_utf8_lossy(&streams.stderr),
            "stdout_truncated":streams.stdout_truncated,"stderr_truncated":streams.stderr_truncated}))
    }

    pub(crate) fn partial_timeout(&self) -> Result<Value> {
        let mut output = self.output(None, None)?;
        output["partial"] = json!(true);
        output["timeout"] = json!(true);
        output["error_code"] = json!("EXECUTION_TIMEOUT");
        // The existing evidence object allows 8 MiB. Escaped control bytes or lossy UTF-8
        // can expand bounded raw output; shorten only the private partial snapshot if needed.
        while output.to_string().len() > 8 * 1024 * 1024 {
            for (field, flag) in [
                ("stdout", "stdout_truncated"),
                ("stderr", "stderr_truncated"),
            ] {
                let text = output[field].as_str().unwrap_or_default();
                let mut keep = text.len() / 2;
                while !text.is_char_boundary(keep) {
                    keep -= 1;
                }
                let shortened = text[..keep].to_owned();
                output[field] = json!(shortened);
                output[flag] = json!(true);
            }
        }
        Ok(output)
    }

    pub(crate) fn mark_recorded(&self) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| crate::err("Transcript lock poisoned"))?
            .recorded = true;
        Ok(())
    }

    pub(crate) fn is_recorded(&self) -> Result<bool> {
        Ok(self
            .0
            .lock()
            .map_err(|_| crate::err("Transcript lock poisoned"))?
            .recorded)
    }
}

#[cfg(test)]
#[path = "tests/agent_transcript.rs"]
mod tests;
