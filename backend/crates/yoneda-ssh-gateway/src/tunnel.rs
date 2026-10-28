//! The Cloudflare Tunnel front door: with `TUNNEL_TOKEN` set, the gateway runs
//! `cloudflared tunnel run` beside itself and restarts it when it exits (backing off to 30 s).
//! The tunnel's route (configured on the tunnel, not here) sends its SSH hostname to this
//! gateway's listener; cloudflared reads the token from its environment, never an argument.
use std::time::Duration;
use tokio::process::Command;

const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// A run this long counts as healthy, so the next failure starts the backoff afresh.
const HEALTHY_RUN: Duration = Duration::from_secs(60);

/// Where cloudflared is installed in the gateway image.
pub const CLOUDFLARED: &str = "/usr/local/bin/cloudflared";

/// The command line (no secrets: the token stays in the inherited environment).
pub fn command(binary: &str) -> Command {
    let mut command = Command::new(binary);
    command
        .args(["tunnel", "--no-autoupdate", "run"])
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

/// Keeps cloudflared running until the gateway stops (dropping the future kills it).
pub async fn supervise(binary: String) {
    let mut wait = Duration::from_secs(1);
    loop {
        let started = std::time::Instant::now();
        match command(&binary).spawn() {
            Ok(mut child) => {
                tracing::info!(pid = child.id(), "tunnel.started");
                let status = child.wait().await;
                tracing::warn!(status = ?status.ok().and_then(|s| s.code()), "tunnel.exited");
            }
            Err(e) => tracing::error!(error = %e, "tunnel.spawn_failed"),
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
}
