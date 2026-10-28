//! YonedaRepo's SSH gateway: stock Git over SSH (`git clone git@host:<repo>.git`) served by
//! bridging Git's SSH transport onto the platform's smart-HTTP endpoints. It holds no
//! repository state and no credentials beyond its host keys and the gateway secret; every
//! access decision is the platform's (cloudflare/worker/platform-ssh.ts).
pub mod auth;
pub mod bridge;
pub mod command;
pub mod config;
pub mod pkt;
pub mod platform;
pub mod server;

use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

/// Connections served at once; more wait in the accept queue.
const CONNECTIONS: usize = 512;
/// How long a stop (SIGTERM) waits for open connections.
const DRAIN: Duration = Duration::from_secs(25);

/// Serves SSH (and the health port) until SIGTERM or Ctrl-C, then drains.
pub async fn serve(config: config::Config) -> std::io::Result<()> {
    let platform = Arc::new(
        platform::Platform::new(&config.platform_url, &config.secret)
            .map_err(std::io::Error::other)?,
    );
    let ssh = Arc::new(server::ssh_config(config.host_keys));
    let listener = TcpListener::bind(config.ssh_listen).await?;
    // Health answers only once SSH is listening, so a start-up wait means SSH is up.
    if let Some(address) = config.health_listen {
        tokio::spawn(health(TcpListener::bind(address).await?));
    }
    tracing::info!(listen = %config.ssh_listen, "ssh.listening");
    let slots = Arc::new(Semaphore::new(CONNECTIONS));
    let stop = shutdown();
    tokio::pin!(stop);
    loop {
        let permit = tokio::select! {
            _ = &mut stop => break,
            permit = slots.clone().acquire_owned() => permit.map_err(std::io::Error::other)?,
        };
        let (stream, _) = tokio::select! {
            _ = &mut stop => break,
            accepted = listener.accept() => accepted?,
        };
        let (ssh, platform) = (ssh.clone(), platform.clone());
        tokio::spawn(async move {
            server::connection(ssh, stream, platform.clone(), platform).await;
            drop(permit);
        });
    }
    tracing::info!("ssh.draining");
    let _ = tokio::time::timeout(DRAIN, slots.acquire_many(CONNECTIONS as u32)).await;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = term.recv() => {},
                _ = tokio::signal::ctrl_c() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// `200 ok` to any HTTP request: the container start-up check.
async fn health(listener: TcpListener) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            continue;
        };
        tokio::spawn(async move {
            let mut request = [0u8; 1024];
            let _ = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut request)).await;
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 3\r\nconnection: close\r\n\r\nok\n")
                .await;
        });
    }
}
