//! Reads that survive a broken stream: a success's body is kept as far as it arrived, and
//! raw bytes can be asked for from an offset, so a caller resumes instead of starting over.
use super::{Api, Coalesce, Failure, unreachable};
use serde_json::Value;

/// A successful answer's body as far as it arrived: `cut` is the transport failure that
/// ended it early (the bytes before it are intact), so a caller can resume instead of
/// starting over.
#[derive(Debug)]
pub struct Received {
    pub status: u16,
    pub bytes: Vec<u8>,
    /// Where the bytes start in the whole resource (a 206's `Content-Range`), else 0.
    pub offset: u64,
    pub cut: Option<Failure>,
}

/// No bytes of `what` for `idle`: a retryable failure, like a dropped connection.
pub(super) fn stalled(what: &str, idle: std::time::Duration) -> Failure {
    Failure {
        status: 0,
        code: "STALLED".into(),
        message: format!("no bytes of {what} for {} ms", idle.as_millis()),
        details: Value::Null,
        retry_after: None,
    }
}

/// A 2xx answer's body, read until it ends, the connection breaks or it sends nothing
/// for `idle` (a stall counts as a cut: the bytes so far are kept).
pub(super) async fn received(
    mut response: reqwest::Response,
    status: u16,
    idle: std::time::Duration,
) -> Received {
    let offset = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(range_start)
        .unwrap_or(0);
    let mut bytes = Vec::new();
    loop {
        let cut = match tokio::time::timeout(idle, response.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                bytes.extend_from_slice(&chunk);
                continue;
            }
            Ok(Ok(None)) => break,
            Ok(Err(e)) => unreachable(e),
            Err(_) => stalled("the answer", idle),
        };
        return Received {
            status,
            bytes,
            offset,
            cut: Some(cut),
        };
    }
    Received {
        status,
        bytes,
        offset,
        cut: None,
    }
}

/// The first byte a `Content-Range: bytes <first>-<last>/<size>` value covers.
fn range_start(value: &str) -> Option<u64> {
    value
        .strip_prefix("bytes ")?
        .split_once('-')?
        .0
        .trim()
        .parse()
        .ok()
}

impl Api {
    /// This client with other idle and total waits (tests use milliseconds).
    pub fn with_timeouts(mut self, idle: std::time::Duration, budget: std::time::Duration) -> Self {
        self.timeouts = super::Timeouts { idle, budget };
        self
    }

    pub(crate) fn timeouts(&self) -> super::Timeouts {
        self.timeouts
    }

    /// Object fetches in flight through this client.
    pub(crate) fn objects(&self) -> &Coalesce {
        &self.objects
    }

    /// One GET of raw bytes from byte `offset` on (a `Range` request past 0), never retried:
    /// the caller resumes from what arrived.
    pub async fn get_bytes_from(
        &self,
        path: &str,
        offset: u64,
    ) -> std::result::Result<Received, Failure> {
        let mut request = self.http.get(format!("{}{path}", self.base));
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }
        self.receive(request, true).await
    }

    /// One read-only POST, never retried: the caller resumes from what arrived.
    pub async fn post_read_once(
        &self,
        path: &str,
        body: &Value,
    ) -> std::result::Result<Received, Failure> {
        let request = self.http.post(format!("{}{path}", self.base)).json(body);
        self.receive(request, true).await
    }
}
