//! The streamed check request (`POST /check/stream`): the same check as the JSON form, with
//! the files as binary frames written to disk as they arrive, so a large tree is never held
//! whole (nor base64-encoded, a third larger) and its files are on disk by the time the last
//! byte lands. Layout, all integers big-endian:
//!
//! - `YCHK1\n`, then a `u32` length and that much JSON: `{command, timeout_seconds}`;
//! - per file: a kind byte (1 blob, 2 exec, 3 symlink), a `u16` path length and the path,
//!   a `u32` content length and the content;
//! - a 0 byte: the end. A body that ends before it is refused.
use crate::check_runner::{
    EntryKind, Materializer, check_dir, execute, invalid, since, valid_timeout,
};
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Instant;
use yoneda_core::Result;

pub const MAGIC: &[u8] = b"YCHK1\n";
const MAX_HEADER: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    command: Vec<String>,
    timeout_seconds: u64,
}

/// One parsed piece of a streamed request.
#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    Header(Vec<u8>),
    File {
        kind: EntryKind,
        path: String,
        data: Vec<u8>,
    },
    End,
}

/// Parses frames out of bytes pushed as they arrive; `limit` refuses a file whose content
/// would pass the check size bound before any of it is buffered.
#[derive(Default)]
pub struct FrameReader {
    buffer: Vec<u8>,
    at: usize,
    started: bool,
    ended: bool,
}

impl FrameReader {
    pub fn push(&mut self, bytes: &[u8]) {
        if self.at > 0 && self.at == self.buffer.len() {
            self.buffer.clear();
            self.at = 0;
        }
        self.buffer.extend_from_slice(bytes);
    }

    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let end = self.at.checked_add(n)?;
        let bytes = self.buffer.get(self.at..end)?;
        self.at = end;
        Some(bytes)
    }

    fn peek_u32(&self, offset: usize) -> Option<usize> {
        let start = self.at.checked_add(offset)?;
        let bytes: [u8; 4] = self.buffer.get(start..start + 4)?.try_into().ok()?;
        usize::try_from(u32::from_be_bytes(bytes)).ok()
    }

    /// The next whole frame, or `None` until more bytes arrive.
    pub fn next(&mut self, limit: impl Fn(usize) -> bool) -> Result<Option<Frame>> {
        if self.ended {
            return Err(invalid("Bytes after the end of a streamed check"));
        }
        if !self.started {
            let Some(len) = self.peek_u32(MAGIC.len()) else {
                return Ok(None);
            };
            if self.buffer.get(self.at..self.at + MAGIC.len()) != Some(MAGIC) {
                return Err(invalid("Not a streamed check request"));
            }
            if len > MAX_HEADER {
                return Err(invalid("Check header too large"));
            }
            if self.buffer.len() - self.at < MAGIC.len() + 4 + len {
                return Ok(None);
            }
            self.at += MAGIC.len() + 4;
            self.started = true;
            let header = self.take(len).map(<[u8]>::to_vec).unwrap_or_default();
            return Ok(Some(Frame::Header(header)));
        }
        let Some(&kind) = self.buffer.get(self.at) else {
            return Ok(None);
        };
        if kind == 0 {
            self.at += 1;
            self.ended = true;
            return Ok(Some(Frame::End));
        }
        let kind = match kind {
            1 => EntryKind::Blob,
            2 => EntryKind::Exec,
            3 => EntryKind::Symlink,
            other => return Err(invalid(format!("Unknown file frame {other}"))),
        };
        let Some(path_len) = self.buffer.get(self.at + 1..self.at + 3) else {
            return Ok(None);
        };
        let path_len = usize::from(u16::from_be_bytes([path_len[0], path_len[1]]));
        let Some(data_len) = self.peek_u32(3 + path_len) else {
            return Ok(None);
        };
        if limit(data_len) {
            return Err(invalid("Check files exceed the size limit"));
        }
        if self.buffer.len() - self.at < 3 + path_len + 4 + data_len {
            return Ok(None);
        }
        self.at += 3;
        let path = String::from_utf8(self.take(path_len).map(<[u8]>::to_vec).unwrap_or_default())
            .map_err(|_| invalid("A file path is not UTF-8"))?;
        self.at += 4;
        let data = self.take(data_len).map(<[u8]>::to_vec).unwrap_or_default();
        Ok(Some(Frame::File { kind, path, data }))
    }
}

/// Reads a streamed check from `body`, writing each file as it lands, then runs it.
pub async fn run_stream<E: std::fmt::Display>(
    mut body: impl Stream<Item = std::result::Result<bytes::Bytes, E>> + Unpin,
    arrived: Instant,
) -> Result<Value> {
    let dir = check_dir()?;
    let mut out = Materializer::new(dir.path());
    let mut reader = FrameReader::default();
    let mut header: Option<Header> = None;
    loop {
        let limit = |n: usize| out.would_exceed(n);
        match reader.next(limit)? {
            Some(Frame::Header(bytes)) => {
                header = Some(
                    serde_json::from_slice(&bytes)
                        .map_err(|e| invalid(format!("Check header: {e}")))?,
                );
            }
            Some(Frame::File { kind, path, data }) => out.write(&path, kind, &data)?,
            Some(Frame::End) => break,
            None => match body.next().await {
                Some(Ok(chunk)) => reader.push(&chunk),
                Some(Err(e)) => return Err(invalid(format!("Check body: {e}"))),
                None => return Err(invalid("The streamed check ended before its last file")),
            },
        }
    }
    let header = header.ok_or_else(|| invalid("A streamed check needs its header"))?;
    let timeout = valid_timeout(header.timeout_seconds)?;
    let setup_ms = since(arrived);
    let (files, bytes) = (out.files(), out.bytes());
    let mut result = execute(dir.path(), &header.command, timeout).await?;
    result["setup_ms"] = json!(setup_ms);
    result["files"] = json!(files);
    result["file_bytes"] = json!(bytes);
    Ok(result)
}
