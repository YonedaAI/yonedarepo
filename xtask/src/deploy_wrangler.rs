//! Retries only Cloudflare's transient Pipeline validation failure for one deploy.
use crate::process::Result;
use std::io::{Read, Write};
use std::process::Stdio;
use std::time::Duration;

const TRANSIENT: &str =
    "Pipeline binding error. Please try again later or contact support. [code: 10021]";
const RETRY_DELAYS: [Option<u64>; 4] = [Some(2), Some(5), Some(10), None];

struct Attempt {
    success: bool,
    failure: String,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Reuses the exact arguments, private config and environment for all attempts.
/// Other Wrangler operations deliberately use the ordinary non-retrying adapter.
pub(crate) fn run(account: &str, args: &[&str], head: &str, dry_run: bool) -> Result<()> {
    if args.first() != Some(&"deploy") {
        return Err("Deploy retry adapter only accepts wrangler deploy".into());
    }
    retry(
        dry_run || args.contains(&"--dry-run"),
        || crate::deploy_source::verify(head),
        || attempt(account, args),
        std::thread::sleep,
    )
}

fn retry(
    dry_run: bool,
    mut verify: impl FnMut() -> Result<()>,
    mut run: impl FnMut() -> Result<Attempt>,
    mut sleep: impl FnMut(Duration),
) -> Result<()> {
    for (index, delay) in RETRY_DELAYS.into_iter().enumerate() {
        // Also fences changes made during the preceding retry delay.
        verify()?;
        let attempt = run()?;
        if attempt.success {
            return Ok(());
        }
        let transient = [&attempt.stdout, &attempt.stderr].iter().any(|bytes| {
            String::from_utf8_lossy(bytes)
                .lines()
                .any(|line| line.trim() == TRANSIENT)
        });
        let Some(delay) = delay.filter(|_| !dry_run && transient) else {
            return Err(attempt.failure.into());
        };
        eprintln!(
            "Cloudflare Pipeline binding validation failed; retrying the same deploy in {delay}s (attempt {}/4).",
            index + 2
        );
        sleep(Duration::from_secs(delay));
    }
    Err("Deploy retry limit exhausted".into())
}

fn attempt(account: &str, args: &[&str]) -> Result<Attempt> {
    println!("$ wrangler {}", args.join(" "));
    let mut child = crate::infra::wrangler::command(account, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot start node_modules/.bin/wrangler: {error}"))?;
    let stdout = child.stdout.take().ok_or("Missing wrangler stdout pipe")?;
    let stderr = child.stderr.take().ok_or("Missing wrangler stderr pipe")?;
    let (status, stdout, stderr) = std::thread::scope(|scope| -> Result<_> {
        let out = scope.spawn(|| tee(stdout, std::io::stdout()));
        let err = scope.spawn(|| tee(stderr, std::io::stderr()));
        let status = child.wait();
        let stdout = out.join().map_err(|_| "Wrangler stdout reader failed")?;
        let stderr = err.join().map_err(|_| "Wrangler stderr reader failed")?;
        Ok((status?, stdout?, stderr?))
    })?;
    Ok(Attempt {
        success: status.success(),
        failure: format!("wrangler {} failed ({status})", args.join(" ")),
        stdout,
        stderr,
    })
}

/// Drain both child pipes concurrently, keeping normal deploy progress visible.
fn tee(mut input: impl Read, mut output: impl Write) -> std::io::Result<Vec<u8>> {
    let mut captured = Vec::new();
    let mut buffer = [0; 8192];
    let mut write_error = None;
    loop {
        let length = input.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        captured.extend_from_slice(&buffer[..length]);
        if write_error.is_none()
            && let Err(error) = output
                .write_all(&buffer[..length])
                .and_then(|()| output.flush())
        {
            // Keep draining to let the child exit even when the terminal closes.
            write_error = Some(error);
        }
    }
    match write_error {
        Some(error) => Err(error),
        None => Ok(captured),
    }
}

#[cfg(test)]
#[path = "deploy_wrangler_tests.rs"]
mod tests;
