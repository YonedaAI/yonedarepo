//! The Cloudflare Tunnel front door: with `TUNNEL_TOKEN` set, the gateway runs
//! `cloudflared tunnel run` beside itself and restarts it when it exits (backing off to 30 s).
//! The tunnel's route (configured on the tunnel, not here) sends its SSH hostname to this
//! gateway's listener; cloudflared reads the token from its environment, never an argument.
//!
//! cloudflared's output is echoed to the gateway's stderr (the container's logs) and its
//! state reported to the platform (`/internal/ssh/status`, so it shows in `wrangler tail`):
//! `tunnel.started`, `tunnel.connected` (its first registered edge connection per run) and
//! `tunnel.exited` with the last lines it printed.
use crate::platform::Platform;
use serde_json::json;
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// A run this long counts as healthy, so the next failure starts the backoff afresh.
const HEALTHY_RUN: Duration = Duration::from_secs(60);
/// Lines of cloudflared output kept for the exit report.
const TAIL_LINES: usize = 20;

/// Where cloudflared is installed in the gateway image.
pub const CLOUDFLARED: &str = "/usr/local/bin/cloudflared";

/// The command line (no secrets: the token stays in the inherited environment).
pub fn command(binary: &str) -> Command {
    let mut command = Command::new(binary);
    command
        .args(["tunnel", "--no-autoupdate", "run"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// The next wait after a run that lasted `ran`, given the previous wait.
pub fn next_backoff(previous: Duration, ran: Duration) -> Duration {
    if ran >= HEALTHY_RUN {
        Duration::from_secs(1)
    } else {
        (previous * 2).clamp(Duration::from_secs(1), BACKOFF_MAX)
    }
}

/// One line of cloudflared output as reported: printable, at most 300 characters, and never
/// the token (cloudflared does not print it; this holds even if a version did).
pub fn scrub(line: &str, token: Option<&str>) -> String {
    let line = match token {
        Some(token) if token.len() >= 8 => line.replace(token, "[token]"),
        _ => line.to_owned(),
    };
    line.chars().filter(|c| !c.is_control()).take(300).collect()
}

/// Whether a line says the tunnel holds an edge connection.
pub fn connected(line: &str) -> bool {
    line.contains("Registered tunnel connection")
}

/// Echoes one output stream, keeps its tail, and reports the first edge connection.
async fn follow(
    stream: impl AsyncRead + Unpin,
    tail: Arc<Mutex<VecDeque<String>>>,
    platform: Arc<Platform>,
    token: Option<String>,
) {
    let mut lines = BufReader::new(stream).lines();
    let mut reported = false;
    while let Ok(Some(line)) = lines.next_line().await {
        let line = scrub(&line, token.as_deref());
        eprintln!("{line}");
        if !reported && connected(&line) {
            reported = true;
            platform
                .report("tunnel.connected", json!({ "line": line }))
                .await;
        }
        let mut tail = tail.lock().await;
        if tail.len() == TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }
}

/// Keeps cloudflared running until the gateway stops (dropping the future kills it).
pub async fn supervise(binary: String, platform: Arc<Platform>) {
    let token = std::env::var("TUNNEL_TOKEN").ok();
    let mut wait = Duration::from_secs(1);
    loop {
        let started = std::time::Instant::now();
        match command(&binary).spawn() {
            Ok(mut child) => {
                tracing::info!(pid = child.id(), "tunnel.started");
                platform
                    .report("tunnel.started", json!({ "pid": child.id() }))
                    .await;
                let tail = Arc::new(Mutex::new(VecDeque::new()));
                let readers: Vec<_> = [
                    child
                        .stdout
                        .take()
                        .map(|s| Box::new(s) as Box<dyn AsyncRead + Unpin + Send>),
                    child
                        .stderr
                        .take()
                        .map(|s| Box::new(s) as Box<dyn AsyncRead + Unpin + Send>),
                ]
                .into_iter()
                .flatten()
                .map(|s| tokio::spawn(follow(s, tail.clone(), platform.clone(), token.clone())))
                .collect();
                let status = child.wait().await.ok().and_then(|s| s.code());
                for reader in readers {
                    let _ = reader.await;
                }
                let tail: Vec<String> = tail.lock().await.iter().cloned().collect();
                tracing::warn!(status = ?status, "tunnel.exited");
                platform
                    .report(
                        "tunnel.exited",
                        json!({
                            "exit_code": status,
                            "ran_s": started.elapsed().as_secs(),
                            "tail": tail,
                        }),
                    )
                    .await;
            }
            Err(e) => {
                tracing::error!(error = %e, "tunnel.spawn_failed");
                platform
                    .report("tunnel.spawn_failed", json!({ "error": e.to_string() }))
                    .await;
            }
        }
        wait = next_backoff(wait, started.elapsed());
        tokio::time::sleep(wait).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_never_an_argument() {
        let command = command(CLOUDFLARED);
        let args: Vec<_> = command.as_std().get_args().collect();
        assert_eq!(args, ["tunnel", "--no-autoupdate", "run"]);
    }

    #[test]
    fn restarts_back_off_and_reset_after_a_healthy_run() {
        let s = Duration::from_secs;
        assert_eq!(next_backoff(s(1), s(0)), s(2));
        assert_eq!(next_backoff(s(16), s(5)), s(30));
        assert_eq!(next_backoff(s(30), s(5)), s(30));
        assert_eq!(next_backoff(s(30), s(600)), s(1));
    }

    #[test]
    fn output_is_scrubbed_and_edge_connections_are_recognized() {
        let token = "eyJhIjoiYWNjb3VudCJ9";
        assert_eq!(
            scrub(&format!("ERR bad token {token}\x1b[0m"), Some(token)),
            "ERR bad token [token][0m"
        );
        assert_eq!(scrub(&"x".repeat(400), None).len(), 300);
        assert!(connected(
            "2026-10-28T17:00:00Z INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.192.7 location=iad08 protocol=http2"
        ));
        assert!(!connected(
            "ERR Unable to establish connection with Cloudflare edge"
        ));
    }
}
