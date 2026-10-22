//! Credential-free bounded HTTP transport to the container-identified source Worker.
use crate::source_client::{SOURCE_FILE_MAX, SOURCE_READ_MAX, failure};
use serde_json::{Value, json};
use std::{
    sync::{Arc, mpsc},
    time::Duration,
};
use yoneda_agents_core::Result;

pub(super) const JSON_LIMIT: usize = 1024 * 1024;
pub(super) struct HttpReply {
    pub value: Value,
    pub bytes: Vec<u8>,
}
pub(super) enum WireRequest {
    Json {
        op: String,
        args: Value,
        supervisor: Option<String>,
    },
    Upload {
        request_id: String,
        query: Vec<(String, String)>,
        bytes: Vec<u8>,
    },
}
struct Pending {
    request: WireRequest,
    reply: mpsc::SyncSender<Result<HttpReply>>,
}
pub(super) struct SourceHttp {
    sender: mpsc::SyncSender<Pending>,
}
impl SourceHttp {
    pub fn new(alias: &str) -> Result<Arc<Self>> {
        Self::at("http://source.yoneda.internal", alias)
    }
    pub fn root(alias: &str, supervisor: &str) -> Result<Arc<Self>> {
        Self::start(
            "http://source.yoneda.internal",
            alias,
            Some(supervisor.into()),
        )
    }
    #[cfg(test)]
    pub(super) fn test_root_at(origin: &str, alias: &str, token: &str) -> Result<Arc<Self>> {
        Self::start(origin, alias, Some(token.into()))
    }
    pub(super) fn at(origin: &str, alias: &str) -> Result<Arc<Self>> {
        Self::start(origin, alias, None)
    }
    fn start(origin: &str, alias: &str, root: Option<String>) -> Result<Arc<Self>> {
        if !["repo", "candidate-0", "candidate-1"].contains(&alias) {
            return Err(failure("INVALID_SOURCE", "Unknown source mount alias"));
        }
        let url = reqwest::Url::parse(&format!("{origin}/v1/{alias}/"))
            .map_err(|_| failure("INVALID_SOURCE", "Invalid source transport"))?;
        let trusted_origin = url.scheme() == "http"
            && url.host_str() == Some("source.yoneda.internal")
            && url.port().is_none();
        let local_test =
            cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
        if (!trusted_origin && !local_test)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(failure("INVALID_SOURCE", "Source endpoint is not internal"));
        }
        let (sender, receiver) = mpsc::sync_channel::<Pending>(32);
        let (ready, prepared) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("source-api".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(30))
                    .build();
                let Ok(runtime) = runtime else {
                    let _ = ready.send(false);
                    return;
                };
                let Ok(client) = client else {
                    let _ = ready.send(false);
                    return;
                };
                let _ = ready.send(true);
                while let Ok(pending) = receiver.recv() {
                    let result =
                        runtime.block_on(send(&client, &url, pending.request, root.as_deref()));
                    let _ = pending.reply.send(result);
                }
            })
            .map_err(|_| failure("SOURCE_TRANSPORT", "Source transport thread unavailable"))?;
        if prepared.recv_timeout(Duration::from_secs(5)) != Ok(true) {
            return Err(failure(
                "SOURCE_TRANSPORT",
                "Source transport failed to initialize",
            ));
        }
        Ok(Arc::new(Self { sender }))
    }
    pub fn send(&self, request: WireRequest) -> Result<HttpReply> {
        // Every source read or write the agent makes is progress for the idle watchdog.
        super::SOURCE_REQUESTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (reply, result) = mpsc::sync_channel(1);
        self.sender
            .try_send(Pending { request, reply })
            .map_err(|_| failure("SOURCE_TRANSPORT", "Source transport unavailable or busy"))?;
        result
            .recv_timeout(Duration::from_secs(35))
            .map_err(|_| failure("SOURCE_UNCERTAIN", "Source request outcome is unconfirmed"))?
    }
    pub fn command(&self, op: &str, args: Value) -> Result<Value> {
        Ok(self
            .send(WireRequest::Json {
                op: op.into(),
                args,
                supervisor: None,
            })?
            .value)
    }
}
async fn send(
    client: &reqwest::Client,
    origin: &reqwest::Url,
    request: WireRequest,
    root: Option<&str>,
) -> Result<HttpReply> {
    let mut expected_read = None;
    let mut explicit_supervisor = None;
    let builder = match request {
        WireRequest::Json {
            op,
            args,
            supervisor,
        } => {
            if op == "source_read" {
                expected_read = Some(args.clone());
            }
            if !op.starts_with("source_") || op.contains('/') {
                return Err(failure("INVALID_SOURCE", "Invalid source operation"));
            }
            explicit_supervisor = supervisor;
            client
                .post(
                    origin
                        .join(&op)
                        .map_err(|_| failure("INVALID_SOURCE", "Invalid source operation"))?,
                )
                .json(&args)
        }
        WireRequest::Upload {
            request_id,
            query,
            bytes,
        } => {
            if bytes.len() as u64 > SOURCE_FILE_MAX
                || request_id.is_empty()
                || request_id.len() > 256
                || request_id.chars().any(char::is_control)
            {
                return Err(failure("SOURCE_LIMIT", "Invalid source upload"));
            }
            client
                .put(
                    origin
                        .join("blob")
                        .map_err(|_| failure("INVALID_SOURCE", "Invalid source upload"))?,
                )
                .query(&query)
                .query(&[("request_id", request_id)])
                .header("content-type", "application/octet-stream")
                .body(bytes)
        }
    };
    if root
        .zip(explicit_supervisor.as_deref())
        .is_some_and(|(root, explicit)| root != explicit)
    {
        return Err(failure(
            "FORBIDDEN",
            "Source supervisor authorization differs",
        ));
    }
    // reqwest appends Authorization values; choose one authority before adding the header.
    let builder = match (root, explicit_supervisor.as_deref()) {
        (Some(supervisor), _) => builder
            .bearer_auth(supervisor)
            .header("x-yoneda-source-fuse", "1"),
        (None, Some(supervisor)) => builder.bearer_auth(supervisor),
        (None, None) => builder,
    };
    let mut response = builder
        .send()
        .await
        .map_err(|_| failure("SOURCE_UNCERTAIN", "Source request outcome is unconfirmed"))?;
    let success = response.status().is_success();
    let read_meta = if success && expected_read.is_some() {
        Some(
            response
                .headers()
                .get("x-yoneda-source")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| failure("SOURCE_FENCED", "Source read metadata missing"))?
                .to_string(),
        )
    } else {
        None
    };
    if read_meta.is_some()
        && (response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            != Some("application/octet-stream")
            || response.headers().contains_key("content-encoding"))
    {
        return Err(failure("SOURCE_FENCED", "Source read is not raw binary"));
    }
    let limit = if read_meta.is_some() {
        SOURCE_READ_MAX
    } else {
        JSON_LIMIT
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| failure("SOURCE_UNCERTAIN", "Source response was interrupted"))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(failure("SOURCE_LIMIT", "Source response exceeds its limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some(metadata) = read_meta {
        let metadata = decode_header(&metadata)?;
        let value: Value = serde_json::from_str(&metadata)
            .map_err(|_| failure("SOURCE_FENCED", "Invalid source read metadata"))?;
        return Ok(HttpReply { value, bytes });
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| failure("SOURCE_UNCERTAIN", "Source response was not typed JSON"))?;
    if !success || value.get("error").is_some() {
        let code = value["error"]["code"]
            .as_str()
            .filter(|code| {
                code.len() < 64
                    && code
                        .bytes()
                        .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
            })
            .unwrap_or("SOURCE_TRANSPORT");
        return Err(failure(code, "Source API rejected the operation"));
    }
    Ok(HttpReply {
        value,
        bytes: Vec::new(),
    })
}
fn decode_header(value: &str) -> Result<String> {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    if bytes.len() > 8192 {
        return Err(failure("SOURCE_LIMIT", "Source header exceeds its limit"));
    }
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes
                .get(index + 1..index + 3)
                .ok_or_else(|| failure("SOURCE_FENCED", "Invalid source header encoding"))?;
            let pair = std::str::from_utf8(pair)
                .map_err(|_| failure("SOURCE_FENCED", "Invalid source header encoding"))?;
            out.push(
                u8::from_str_radix(pair, 16)
                    .map_err(|_| failure("SOURCE_FENCED", "Invalid source header encoding"))?,
            );
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| failure("SOURCE_FENCED", "Invalid source header encoding"))
}
pub(super) fn args(path: &str) -> Value {
    json!({"path":path})
}
