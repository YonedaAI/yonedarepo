//! Git's SSH transport onto the platform's smart-HTTP endpoints.
//!
//! Fetch (protocol version 2): the advertisement from `GET info/refs` (with `Git-Protocol:
//! version=2`), then each request the client sends, read up to its flush, becomes one
//! `POST /git-upload-pack` whose answer streams back. A lone flush or end of input ends the
//! session. Version 0 fetches are refused with how to switch.
//!
//! Push (version 0): the advertisement from `GET info/refs?service=git-receive-pack` without
//! its HTTP preamble, then one `POST /git-receive-pack` carrying the command list, any push
//! options and, unless every command deletes, the pack up to the end of input (Git closes
//! its side of the channel after the pack).
use crate::command::{GitCommand, Service};
use crate::pkt::{self, Pkt, PushPlan};
use crate::platform::{Identity, Platform, PlatformError, SessionToken};
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use russh::server::Msg;
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf};

/// The largest single request (pkt-lines up to a flush) the gateway forwards.
const REQUEST_LIMIT: usize = 8 * 1024 * 1024;
const STDERR: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("{0}")]
    Platform(#[from] PlatformError),
    #[error("protocol error: {0}")]
    Protocol(&'static str),
    #[error("connection closed: {0}")]
    Ssh(#[from] russh::Error),
}

impl From<pkt::Malformed> for BridgeError {
    fn from(_: pkt::Malformed) -> Self {
        BridgeError::Protocol("malformed pkt-line")
    }
}

/// The client's side of the channel: buffered data until end of input.
pub struct Input {
    channel: ChannelReadHalf,
    buffer: BytesMut,
    ended: bool,
}

impl Input {
    pub fn new(channel: ChannelReadHalf) -> Self {
        Input {
            channel,
            buffer: BytesMut::new(),
            ended: false,
        }
    }

    /// Waits for more data; false at end of input.
    async fn fill(&mut self) -> bool {
        while !self.ended {
            match self.channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    self.buffer.extend_from_slice(&data);
                    return true;
                }
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => self.ended = true,
                Some(_) => {} // requests and window changes are not input
            }
        }
        false
    }

    /// The next pkt-line and its raw bytes, or `None` at end of input between lines.
    pub async fn pkt(&mut self) -> Result<Option<(Pkt, Bytes)>, BridgeError> {
        loop {
            if let Some((pkt, used)) = pkt::parse(&self.buffer)? {
                return Ok(Some((pkt, self.buffer.split_to(used).freeze())));
            }
            if !self.fill().await {
                return if self.buffer.is_empty() {
                    Ok(None)
                } else {
                    Err(BridgeError::Protocol("input ended inside a pkt-line"))
                };
            }
        }
    }

    /// Buffered bytes first, then each data message, until end of input.
    pub async fn chunk(&mut self) -> Option<Bytes> {
        if self.buffer.is_empty() && !self.fill().await {
            return None;
        }
        Some(self.buffer.split().freeze())
    }

    /// Pkt-lines up to and including a flush (one request), or `None` at end of input.
    async fn request(
        &mut self,
        mut note: impl FnMut(&[u8]),
    ) -> Result<Option<Vec<u8>>, BridgeError> {
        let mut request = Vec::new();
        loop {
            let Some((pkt, raw)) = self.pkt().await? else {
                return if request.is_empty() {
                    Ok(None)
                } else {
                    Err(BridgeError::Protocol("input ended inside a request"))
                };
            };
            request.extend_from_slice(&raw);
            if request.len() > REQUEST_LIMIT {
                return Err(BridgeError::Protocol("request too large"));
            }
            match pkt {
                Pkt::Flush => return Ok(Some(request)),
                Pkt::Data(line) => note(&line),
                Pkt::Delim | Pkt::ResponseEnd => {}
            }
        }
    }
}

/// The client's side of the channel for output.
pub type Output = ChannelWriteHalf<Msg>;

/// Streams a platform answer to the client.
async fn relay(output: &Output, response: reqwest::Response) -> Result<(), BridgeError> {
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        output
            .data_bytes(chunk.map_err(PlatformError::from)?)
            .await?;
    }
    Ok(())
}

/// A line on the client's stderr (Git prints it as is).
pub async fn say(output: &Output, message: &str) {
    let _ = output
        .extended_data_bytes(STDERR, Bytes::from(format!("{message}\n")))
        .await;
}

/// The session token, renewed when it is close to expiry (which re-checks the key).
struct Session<'a> {
    platform: &'a Platform,
    identity: &'a Identity,
    command: &'a GitCommand,
    token: SessionToken,
}

impl<'a> Session<'a> {
    async fn open(
        platform: &'a Platform,
        identity: &'a Identity,
        command: &'a GitCommand,
    ) -> Result<Session<'a>, BridgeError> {
        let token = platform
            .session(identity, &command.repo, command.service)
            .await?;
        Ok(Session {
            platform,
            identity,
            command,
            token,
        })
    }
    async fn token(&mut self) -> Result<&SessionToken, BridgeError> {
        if self.token.stale() {
            self.token = self
                .platform
                .session(self.identity, &self.command.repo, self.command.service)
                .await?;
        }
        Ok(&self.token)
    }
}

/// Runs one Git command to completion; the exit status for the client.
pub async fn run(
    platform: &Platform,
    identity: &Identity,
    command: &GitCommand,
    v2: bool,
    input: Input,
    output: &Output,
) -> u32 {
    let outcome = match command.service {
        Service::UploadPack if !v2 => {
            say(
                output,
                "ERROR: YonedaRepo serves fetches over SSH with Git protocol version 2 only.\n\
                 Run `git config --global protocol.version 2` (the default since Git 2.26) and retry.",
            )
            .await;
            return 128;
        }
        Service::UploadPack => fetch(platform, identity, command, input, output).await,
        Service::ReceivePack => push(platform, identity, command, input, output).await,
    };
    match outcome {
        Ok(()) => 0,
        Err(e) => {
            let message = match &e {
                BridgeError::Platform(p) => p.client_message(),
                other => other.to_string(),
            };
            tracing::info!(repo = %command.repo, service = command.service.name(), error = %e, "ssh.command_failed");
            say(output, &format!("ERROR: {message}")).await;
            128
        }
    }
}

async fn fetch(
    platform: &Platform,
    identity: &Identity,
    command: &GitCommand,
    mut input: Input,
    output: &Output,
) -> Result<(), BridgeError> {
    let mut session = Session::open(platform, identity, command).await?;
    let advertised = platform
        .advertisement(
            session.token().await?,
            &command.repo,
            Service::UploadPack,
            true,
        )
        .await?;
    output
        .data_bytes(Bytes::copy_from_slice(pkt::strip_service_preamble(
            &advertised,
        )))
        .await?;
    while let Some(request) = input.request(|_| {}).await? {
        if request == b"0000" {
            break; // the client is done
        }
        let token = session.token().await?;
        let answer = platform
            .rpc(
                token,
                &command.repo,
                Service::UploadPack,
                true,
                request.into(),
            )
            .await?;
        relay(output, answer).await?;
    }
    Ok(())
}

async fn push(
    platform: &Platform,
    identity: &Identity,
    command: &GitCommand,
    mut input: Input,
    output: &Output,
) -> Result<(), BridgeError> {
    let mut session = Session::open(platform, identity, command).await?;
    let advertised = platform
        .advertisement(
            session.token().await?,
            &command.repo,
            Service::ReceivePack,
            false,
        )
        .await?;
    output
        .data_bytes(Bytes::copy_from_slice(pkt::strip_service_preamble(
            &advertised,
        )))
        .await?;
    let mut plan = PushPlan::default();
    let Some(mut head) = input.request(|line| plan.note(line)).await? else {
        return Ok(()); // the client left after the advertisement
    };
    if plan.commands == 0 {
        return Ok(()); // nothing to push
    }
    if plan.options {
        let options = input
            .request(|_| {})
            .await?
            .ok_or(BridgeError::Protocol("input ended before the push options"))?;
        head.extend_from_slice(&options);
    }
    let token = session.token().await?.clone();
    let body = if plan.pack {
        let rest = futures_util::stream::unfold(input, |mut input| async move {
            input
                .chunk()
                .await
                .map(|chunk| (Ok::<_, std::io::Error>(chunk), input))
        });
        let first = futures_util::stream::once(async move { Ok(Bytes::from(head)) });
        reqwest::Body::wrap_stream(first.chain(rest))
    } else {
        head.into()
    };
    let answer = platform
        .rpc(&token, &command.repo, Service::ReceivePack, false, body)
        .await?;
    relay(output, answer).await
}
