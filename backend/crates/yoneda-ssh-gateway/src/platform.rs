//! The platform as the gateway sees it: key lookups and session tokens on `/internal/ssh/*`
//! (an HS256 JWT signed with the gateway secret, a minute long), and Git's smart-HTTP
//! endpoints with the session token as bearer. Inside Cloudflare the base URL is
//! `http://platform.internal`, which the container's Worker serves itself.
use crate::command::{RepoId, Service};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// An account's key, as the platform answered for a verified signature.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Identity {
    pub account: String,
    pub key_id: String,
    #[serde(skip)]
    pub fingerprint: String,
}

/// A session token for one repository and service.
#[derive(Debug, Clone, Deserialize)]
pub struct SessionToken {
    pub token: String,
    /// Milliseconds since the Unix epoch.
    pub expires_at: i64,
}

impl SessionToken {
    /// Whether it should be renewed before the next request (a minute of slack).
    pub fn stale(&self) -> bool {
        now_ms() + 60_000 >= self.expires_at
    }
}

/// Why the platform did not serve a request; `message` is safe to show the client.
#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("{message}")]
    Refused { status: u16, message: String },
    #[error("platform unreachable: {0}")]
    Transport(#[from] reqwest::Error),
}

impl PlatformError {
    /// The text the client sees on stderr.
    pub fn client_message(&self) -> String {
        match self {
            // The session token's key was removed (or the token expired with it).
            PlatformError::Refused { status: 401, .. } => {
                "this SSH key is no longer authorized; add one in Settings > SSH keys".into()
            }
            PlatformError::Refused { message, .. } => message.clone(),
            PlatformError::Transport(_) => "the platform is unavailable; try again".into(),
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Printable, single-line text of at most 500 characters from a platform refusal.
fn sanitize(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(500)
        .collect::<String>()
        .trim()
        .to_owned()
}

pub struct Platform {
    http: reqwest::Client,
    base: String,
    secret: Vec<u8>,
}

impl Platform {
    pub fn new(base: &str, secret: &[u8]) -> Result<Platform, reqwest::Error> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // Between bytes; whole clones and pushes may take far longer.
            .read_timeout(Duration::from_secs(300))
            .build()?;
        Ok(Platform {
            http,
            base: base.trim_end_matches('/').to_owned(),
            secret: secret.to_vec(),
        })
    }

    /// The gateway's credential for `/internal/ssh/*`.
    pub fn gateway_jwt(&self) -> String {
        let now = now_ms() / 1000;
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let claims =
            json!({"iss":"yoneda-ssh-gateway","aud":"yoneda-platform","iat":now,"exp":now+60});
        let claims = URL_SAFE_NO_PAD.encode(claims.to_string());
        let signing = format!("{header}.{claims}");
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.secret)
            .unwrap_or_else(|_| unreachable!("HMAC takes keys of any length"));
        mac.update(signing.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{signing}.{signature}")
    }

    async fn internal(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<reqwest::Response, PlatformError> {
        Ok(self
            .http
            .post(format!("{}/internal/ssh/{path}", self.base))
            .bearer_auth(self.gateway_jwt())
            .json(&body)
            .send()
            .await?)
    }

    /// Reports the gateway's own state (`gateway.*`, `tunnel.*`) to the platform's log; best
    /// effort, a few seconds at most, never failing the caller.
    pub async fn report(&self, event: &str, detail: serde_json::Value) {
        let sent = tokio::time::timeout(
            Duration::from_secs(5),
            self.internal("status", json!({ "event": event, "detail": detail })),
        )
        .await;
        if !matches!(sent, Ok(Ok(ref r)) if r.status().is_success()) {
            tracing::warn!(event, "report.failed");
        }
    }

    /// The account and key a verified public key belongs to, or `None`.
    pub async fn lookup(&self, fingerprint: &str) -> Result<Option<Identity>, PlatformError> {
        let found = self.find(fingerprint).await;
        if let Err(e) = &found {
            self.failed("lookup", e).await;
        }
        found
    }

    async fn find(&self, fingerprint: &str) -> Result<Option<Identity>, PlatformError> {
        let response = self
            .internal("lookup", json!({ "fingerprint": fingerprint }))
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let mut identity: Identity = checked(response).await?.json().await?;
        identity.fingerprint = fingerprint.to_owned();
        Ok(Some(identity))
    }

    /// A session token for `identity` on one repository and service.
    pub async fn session(
        &self,
        identity: &Identity,
        repo: &RepoId,
        service: Service,
    ) -> Result<SessionToken, PlatformError> {
        let body = json!({
            "account": identity.account, "key_id": identity.key_id,
            "fingerprint": identity.fingerprint, "repo": repo.as_str(), "service": service.name(),
        });
        let minted = async {
            Ok(checked(self.internal("session", body).await?)
                .await?
                .json()
                .await?)
        };
        let minted = minted.await;
        if let Err(e) = &minted {
            self.failed("session", e).await;
        }
        minted
    }

    /// A failed internal call, in the container's log and (when the platform is reachable at
    /// all) the platform's: `gateway.lookup_failed` / `gateway.session_failed` with the URL and
    /// HTTP status, so a refused route (520) or a secret mismatch (401) is visible.
    async fn failed(&self, call: &str, error: &PlatformError) {
        let url = format!("{}/internal/ssh/{call}", self.base);
        let status = match error {
            PlatformError::Refused { status, .. } => Some(*status),
            PlatformError::Transport(e) => e.status().map(|s| s.as_u16()),
        };
        tracing::warn!(%url, ?status, error = %error, "gateway.{call}_failed");
        let event = format!("gateway.{call}_failed");
        let detail = json!({ "url": url, "status": status, "error": error.to_string() });
        self.report(&event, detail).await;
    }

    fn git_url(&self, repo: &RepoId, tail: &str) -> String {
        format!("{}/git/{repo}.git/{tail}", self.base)
    }

    /// The smart-HTTP advertisement (`info/refs`), whole.
    pub async fn advertisement(
        &self,
        token: &SessionToken,
        repo: &RepoId,
        service: Service,
        v2: bool,
    ) -> Result<bytes::Bytes, PlatformError> {
        let mut request = self
            .http
            .get(self.git_url(repo, &format!("info/refs?service={}", service.name())))
            .bearer_auth(&token.token);
        if v2 {
            request = request.header("git-protocol", "version=2");
        }
        Ok(checked(request.send().await?).await?.bytes().await?)
    }

    /// One stateless-RPC request (`POST /git-upload-pack` or `/git-receive-pack`); the
    /// answer streams.
    pub async fn rpc(
        &self,
        token: &SessionToken,
        repo: &RepoId,
        service: Service,
        v2: bool,
        body: reqwest::Body,
    ) -> Result<reqwest::Response, PlatformError> {
        let mut request = self
            .http
            .post(self.git_url(repo, service.name()))
            .bearer_auth(&token.token)
            .header(
                "content-type",
                format!("application/x-{}-request", service.name()),
            )
            .body(body);
        if v2 {
            request = request.header("git-protocol", "version=2");
        }
        checked(request.send().await?).await
    }
}

/// The response when it succeeded; otherwise its text as a refusal.
async fn checked(response: reqwest::Response) -> Result<reqwest::Response, PlatformError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    // JSON errors (`/internal/ssh`) carry their message; Git's endpoints answer plain text.
    let message = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or(text);
    let message = match sanitize(&message) {
        m if m.is_empty() => format!("the platform answered HTTP {status}"),
        m => m,
    };
    Err(PlatformError::Refused { status, message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gateway_jwt_is_hs256_over_its_claims() {
        let platform = Platform::new(
            "http://platform.internal/",
            b"0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        assert_eq!(platform.base, "http://platform.internal");
        let jwt = platform.gateway_jwt();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "yoneda-ssh-gateway");
        assert_eq!(claims["aud"], "yoneda-platform");
        assert_eq!(
            claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
            60
        );
        let mut mac =
            <Hmac<Sha256> as KeyInit>::new_from_slice(b"0123456789abcdef0123456789abcdef").unwrap();
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        mac.verify_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap())
            .unwrap();
    }

    #[test]
    fn refusals_are_one_printable_line() {
        assert_eq!(
            sanitize("FORBIDDEN: no\r\n\x1b[31mred"),
            "FORBIDDEN: no   [31mred"
        );
        assert_eq!(sanitize(&"x".repeat(900)).len(), 500);
    }

    /// A platform stand-in: answers `/internal/ssh/lookup` with `status` and records each
    /// request's path and body.
    async fn stand_in(status: u16) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = request.split(' ').nth(1).unwrap_or_default().to_owned();
                let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
                log.lock().unwrap().push(format!("{path} {body}"));
                let code = if path.ends_with("/lookup") {
                    status
                } else {
                    200
                };
                let reply = format!(
                    "HTTP/1.1 {code} X\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}"
                );
                let _ = stream.write_all(reply.as_bytes()).await;
            }
        });
        (base, seen)
    }

    #[tokio::test]
    async fn a_refused_lookup_is_reported_with_its_url_and_status() {
        let (base, seen) = stand_in(520).await;
        let platform = Platform::new(&base, &[7; 32]).unwrap();
        let fingerprint = "SHA256:8EqRGtHv7KPU4JP7ITUpjcB1ZW5aJP4ISN49NDYsKWo";
        assert!(platform.lookup(fingerprint).await.is_err());
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert!(seen[0].starts_with("/internal/ssh/lookup "));
        let report: serde_json::Value =
            serde_json::from_str(seen[1].split_once(' ').unwrap().1).unwrap();
        assert_eq!(report["event"], "gateway.lookup_failed");
        assert_eq!(report["detail"]["status"], 520);
        assert_eq!(
            report["detail"]["url"],
            format!("{base}/internal/ssh/lookup")
        );
        // An unknown key is an answer, not a failure: nothing is reported.
        let (base, seen) = stand_in(404).await;
        let platform = Platform::new(&base, &[7; 32]).unwrap();
        assert_eq!(platform.lookup(fingerprint).await.unwrap(), None);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
}
