//! A recording HTTP proxy in front of the local platform, for what the platform cannot
//! show on demand: a push killed mid-flight (chosen requests hang until the client dies),
//! a ref that moves between a push's listing and its batch, and a device-login stub.
//! `refs/batch` is forwarded; only if the platform lacks it (404) does the proxy apply
//! it itself (check every expected head, then move each), so the helper's atomic path
//! is exercised either way.
use super::TestResult;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A request the proxy sends upstream before handling a `refs/batch` (to make a ref stale).
pub struct Interpose {
    pub path: String,
    pub body: Value,
    pub bearer: String,
}

#[derive(Default)]
pub struct State {
    /// (method, path) of every request seen.
    pub log: Vec<(String, String)>,
    /// POST paths ending with one of these never get an answer.
    pub hang: Vec<String>,
    pub before_batch: Option<Interpose>,
    /// Device-login stub: polls answered AUTHORIZATION_PENDING before the grant.
    pub device_pending: usize,
    pub device_token: Option<String>,
}

pub struct Proxy {
    pub origin: String,
    pub state: Arc<Mutex<State>>,
}

impl Proxy {
    pub fn start(upstream: &str) -> TestResult<Self> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let origin = format!(
            "http://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let upstream = upstream.to_owned();
        std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            rt.block_on(async move {
                let Ok(listener) = TcpListener::from_std(listener) else {
                    return;
                };
                let http = reqwest::Client::new();
                while let Ok((stream, _)) = listener.accept().await {
                    let (state, http, upstream) = (shared.clone(), http.clone(), upstream.clone());
                    tokio::spawn(async move {
                        let _ = serve(stream, state, http, upstream).await;
                    });
                }
            });
        });
        Ok(Self { origin, state })
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        let mut guard = match self.state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&mut guard)
    }

    pub fn count(&self, method: &str, suffix: &str) -> usize {
        self.with(|s| {
            s.log
                .iter()
                .filter(|(m, p)| m == method && p.split('?').next().unwrap_or(p).ends_with(suffix))
                .count()
        })
    }
}

struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

async fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(i) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_owned(), first.next()?.to_owned());
    let mut length = 0usize;
    let mut authorization = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "content-length" => length = value.trim().parse().unwrap_or(0),
                "authorization" => authorization = Some(value.trim().to_owned()),
                _ => {}
            }
        }
    }
    let mut body = buffer[head_end..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(Request {
        method,
        path,
        authorization,
        body,
    })
}

async fn respond(stream: &mut TcpStream, status: u16, body: &Value) {
    let text = body.to_string();
    let head = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        text.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(text.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn forward(
    http: &reqwest::Client,
    upstream: &str,
    method: &str,
    path: &str,
    authorization: Option<&str>,
    body: Vec<u8>,
) -> (u16, Value) {
    let Ok(method) = reqwest::Method::from_bytes(method.as_bytes()) else {
        return (400, json!({}));
    };
    let mut request = http.request(method, format!("{upstream}{path}"));
    if let Some(value) = authorization {
        request = request.header("authorization", value);
    }
    if !body.is_empty() {
        request = request
            .header("content-type", "application/json")
            .body(body);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let value = response.json().await.unwrap_or(Value::Null);
            (status, value)
        }
        Err(e) => (
            502,
            json!({ "error": { "code": "UPSTREAM", "message": e.to_string() } }),
        ),
    }
}

/// `refs/batch` applied by the proxy: every expected head checked, then each moved.
async fn batch_shim(
    http: &reqwest::Client,
    upstream: &str,
    path: &str,
    authorization: Option<&str>,
    body: &[u8],
) -> (u16, Value) {
    let repo_path = path.trim_end_matches("/refs/batch");
    let request: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let (_, refs) = forward(
        http,
        upstream,
        "GET",
        &format!("{repo_path}/refs"),
        authorization,
        Vec::new(),
    )
    .await;
    let updates = request["updates"].as_array().cloned().unwrap_or_default();
    let stale: Vec<Value> = updates
        .iter()
        .filter(|u| {
            let name = u["ref"].as_str().unwrap_or_default();
            refs["refs"][name] != u["expected"] && refs["refs"][name] != u["commit"]
        })
        .map(|u| u["ref"].clone())
        .collect();
    if !stale.is_empty() {
        let error =
            json!({ "code": "STALE_HEAD", "message": "stale", "details": { "stale": stale } });
        return (409, json!({ "error": error }));
    }
    for update in &updates {
        let body = serde_json::to_vec(update).unwrap_or_default();
        let (status, value) = forward(
            http,
            upstream,
            "POST",
            &format!("{repo_path}/branches"),
            authorization,
            body,
        )
        .await;
        if status >= 300 {
            return (status, value);
        }
    }
    (200, json!({ "version": 0, "refs": updates }))
}

async fn serve(
    mut stream: TcpStream,
    state: Arc<Mutex<State>>,
    http: reqwest::Client,
    upstream: String,
) -> Option<()> {
    let request = read_request(&mut stream).await?;
    let lock = || match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let route = request
        .path
        .split('?')
        .next()
        .unwrap_or_default()
        .to_owned();
    let hang = {
        let mut s = lock();
        s.log.push((request.method.clone(), request.path.clone()));
        request.method == "POST" && s.hang.iter().any(|h| route.ends_with(h.as_str()))
    };
    if hang {
        tokio::time::sleep(Duration::from_secs(3600)).await;
        return Some(());
    }
    let auth = request.authorization.as_deref();
    let (status, body) = match route.as_str() {
        "/api/v1/device/code" => (
            200,
            json!({ "device_code": "dev-code-1", "user_code": "ABCD-EFGH",
                    "verification_uri": format!("{upstream}/device"),
                    "verification_uri_complete": format!("{upstream}/device?code=ABCD-EFGH"),
                    "expires_in": 60, "interval": 0 }),
        ),
        "/api/v1/device/token" => {
            let mut s = lock();
            if s.device_pending > 0 {
                s.device_pending -= 1;
                let error = json!({ "code": "AUTHORIZATION_PENDING", "message": "pending" });
                (400, json!({ "error": error }))
            } else {
                let token = s.device_token.clone().unwrap_or_default();
                (
                    200,
                    json!({ "token": token, "scopes": ["repo:read"], "repos": null,
                              "expires_at": "2026-11-20T00:00:00Z", "account": "kit" }),
                )
            }
        }
        _ if route.ends_with("/refs/batch") && request.method == "POST" => {
            let interpose = lock().before_batch.take();
            if let Some(i) = interpose {
                let bearer = format!("Bearer {}", i.bearer);
                let body = serde_json::to_vec(&i.body).unwrap_or_default();
                forward(&http, &upstream, "POST", &i.path, Some(&bearer), body).await;
            }
            let (status, value) = forward(
                &http,
                &upstream,
                "POST",
                &request.path,
                auth,
                request.body.clone(),
            )
            .await;
            if status == 404 {
                batch_shim(&http, &upstream, &route, auth, &request.body).await
            } else {
                (status, value)
            }
        }
        _ => {
            forward(
                &http,
                &upstream,
                &request.method,
                &request.path,
                auth,
                request.body,
            )
            .await
        }
    };
    respond(&mut stream, status, &body).await;
    Some(())
}
