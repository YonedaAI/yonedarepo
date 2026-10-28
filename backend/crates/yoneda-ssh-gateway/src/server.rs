//! The SSH server: public-key authentication only (user `git`), at most six attempts and
//! thirty seconds before authenticating, keepalives every twenty seconds; per session
//! channel, `env GIT_PROTOCOL` then one `exec` of a Git command (bridge.rs), or a shell
//! request, which only greets. Everything else is refused.
use crate::auth::{Authenticator, Directory};
use crate::bridge::{self, Input};
use crate::command::{self, GitCommand};
use crate::platform::Platform;
use russh::keys::PrivateKey;
use russh::server::{Auth, ChannelOpenHandle, Msg, Session};
use russh::{Channel, ChannelId, ChannelOpenFailure, Disconnect, MethodSet};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::net::TcpStream;

const PRE_AUTH: Duration = Duration::from_secs(30);
const MAX_AUTH_ATTEMPTS: usize = 6;
const KEEPALIVE: Duration = Duration::from_secs(20);
const CHANNELS_PER_CONNECTION: usize = 4;

pub fn ssh_config(host_keys: Vec<PrivateKey>) -> russh::server::Config {
    russh::server::Config {
        server_id: russh::SshId::Standard("SSH-2.0-YonedaRepo".into()),
        methods: MethodSet::from(&[russh::MethodKind::PublicKey][..]),
        auth_rejection_time: Duration::from_millis(500),
        // OpenSSH probes with `none` first; that needs no delay.
        auth_rejection_time_initial: Some(Duration::ZERO),
        max_auth_attempts: MAX_AUTH_ATTEMPTS,
        keys: host_keys,
        inactivity_timeout: Some(Duration::from_secs(600)),
        keepalive_interval: Some(KEEPALIVE),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    }
}

/// A session channel before its `exec`.
struct Pending {
    channel: Channel<Msg>,
    git_protocol: Option<String>,
}

pub struct Connection<D> {
    auth: Authenticator<D>,
    platform: Arc<Platform>,
    authenticated: Arc<AtomicBool>,
    pending: HashMap<ChannelId, Pending>,
    opened: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectionError {
    #[error(transparent)]
    Ssh(#[from] russh::Error),
}

impl<D: Directory> Connection<D> {
    pub fn new(directory: D, platform: Arc<Platform>, authenticated: Arc<AtomicBool>) -> Self {
        Connection {
            auth: Authenticator::new(directory),
            platform,
            authenticated,
            pending: HashMap::new(),
            opened: 0,
        }
    }
}

impl<D: Directory> russh::server::Handler for Connection<D> {
    type Error = ConnectionError;

    async fn auth_publickey_offered(
        &mut self,
        user: &str,
        _offer: russh::server::PublicKeyOffer<'_>,
    ) -> Result<Auth, Self::Error> {
        Ok(if self.auth.offered(user) {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: russh::server::VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        if self.auth.verified(user, key.public_key).await {
            self.authenticated.store(true, Ordering::SeqCst);
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.opened >= CHANNELS_PER_CONNECTION {
            reply.reject(ChannelOpenFailure::ResourceShortage).await;
            return Ok(());
        }
        self.opened += 1;
        reply.accept().await;
        self.pending.insert(
            channel.id(),
            Pending {
                channel,
                git_protocol: None,
            },
        );
        Ok(())
    }

    async fn env_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        value: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        match self.pending.get_mut(&channel) {
            Some(pending) if name == "GIT_PROTOCOL" && command::plausible_git_protocol(value) => {
                pending.git_protocol = Some(value.to_owned());
                session.channel_success(channel)?;
            }
            _ => session.channel_failure(channel)?,
        }
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let (Some(identity), Some(pending)) =
            (self.auth.identity().cloned(), self.pending.remove(&channel))
        else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        let Some(command) = command::parse(data) else {
            session.channel_success(channel)?;
            let message = "ERROR: only `git clone`, `git fetch` and `git push` are served here (git-upload-pack or git-receive-pack '<repository id>.git')";
            refuse(session, channel, message)?;
            return Ok(());
        };
        session.channel_success(channel)?;
        let v2 = command::wants_v2(pending.git_protocol.as_deref());
        let platform = self.platform.clone();
        tokio::spawn(execute(platform, identity, command, v2, pending.channel));
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(identity) = self.auth.identity() else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        self.pending.remove(&channel);
        session.channel_success(channel)?;
        let account: String = identity
            .account
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            .collect();
        let greeting = format!(
            "Hi {account}! You've successfully authenticated, but YonedaRepo does not provide shell access."
        );
        refuse(session, channel, &greeting)
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }
}

/// A message on stderr, exit status 1, and the channel closed.
fn refuse(session: &mut Session, channel: ChannelId, message: &str) -> Result<(), ConnectionError> {
    session.extended_data(channel, 1, format!("{message}\n"))?;
    session.exit_status_request(channel, 1)?;
    session.eof(channel)?;
    session.close(channel)?;
    Ok(())
}

async fn execute(
    platform: Arc<Platform>,
    identity: crate::platform::Identity,
    command: GitCommand,
    v2: bool,
    channel: Channel<Msg>,
) {
    let (read, write) = channel.split();
    let started = std::time::Instant::now();
    let status = bridge::run(&platform, &identity, &command, v2, Input::new(read), &write).await;
    tracing::info!(
        account = %identity.account, repo = %command.repo, service = command.service.name(),
        status, ms = started.elapsed().as_millis() as u64, "ssh.command"
    );
    let _ = write.eof().await;
    let _ = write.exit_status(status).await;
    let _ = write.close().await;
}

/// Serves one TCP connection until it ends; unauthenticated connections end after 30 s.
pub async fn connection<D: Directory>(
    config: Arc<russh::server::Config>,
    stream: TcpStream,
    directory: D,
    platform: Arc<Platform>,
) {
    let authenticated = Arc::new(AtomicBool::new(false));
    let handler = Connection::new(directory, platform, authenticated.clone());
    let session =
        match tokio::time::timeout(PRE_AUTH, russh::server::run_stream(config, stream, handler))
            .await
        {
            Ok(Ok(session)) => session,
            Ok(Err(e)) => {
                tracing::debug!(error = %e, "ssh.handshake_failed");
                return;
            }
            Err(_) => return,
        };
    let handle = session.handle();
    let deadline = tokio::spawn(async move {
        tokio::time::sleep(PRE_AUTH).await;
        if !authenticated.load(Ordering::SeqCst) {
            let _ = handle
                .disconnect(
                    Disconnect::ByApplication,
                    "authentication timed out".into(),
                    "en".into(),
                )
                .await;
        }
    });
    if let Err(e) = session.await {
        tracing::debug!(error = %e, "ssh.session_ended");
    }
    deadline.abort();
}
