//! The platform's public HTTP API (`/api/v1/repos/:id`), as this client uses it.
use crate::credentials::{Header, Token};
use crate::error::{Error, Result};
use serde_json::{Value, json};
use std::fmt;

/// A refused or failed API call, with the platform's error code and details.
#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Value,
    /// Seconds the platform asked the client to wait (`Retry-After` on a 503 OVERLOADED).
    pub retry_after: Option<u64>,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.status, self.message)
    }
}

/// No answer, an unreadable one, a gateway error or an overloaded platform (503
/// OVERLOADED): worth retrying a call that is safe to repeat.
fn transient(failure: &Failure) -> bool {
    matches!(failure.status, 0 | 502 | 503 | 504)
}

/// Retries after the first attempt, and the longest `Retry-After` honoured.
const RETRIES: u64 = 3;
const MAX_RETRY_AFTER_SECONDS: u64 = 10;

/// The wait before retry `attempt` (1-based): the platform's `Retry-After` when it gave one,
/// else a linear backoff, plus up to 250 ms of jitter so retrying clients spread out.
fn backoff(failure: &Failure, attempt: u64) -> std::time::Duration {
    let base = failure
        .retry_after
        .map_or(1000 * attempt, |s| 1000 * s.min(MAX_RETRY_AFTER_SECONDS));
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_nanos()) % 250);
    std::time::Duration::from_millis(base + jitter)
}

impl From<Failure> for Error {
    fn from(failure: Failure) -> Self {
        Error::new(failure.to_string())
    }
}

/// A recorded platform commit, as much of it as the client needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInfo {
    pub commit: String,
    pub tree: String,
    pub parents: Vec<String>,
}

pub struct Api {
    http: reqwest::Client,
    base: String,
    header: Header,
}

pub fn valid_repo_id(repo: &str) -> bool {
    repo.len() == 21
        && repo.starts_with('r')
        && repo[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn text(value: &Value, field: &str) -> std::result::Result<String, Failure> {
    value[field]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| malformed(&format!("missing {field}")))
}

fn malformed(what: &str) -> Failure {
    Failure {
        status: 0,
        code: "MALFORMED_RESPONSE".into(),
        message: format!("Unexpected platform response: {what}"),
        details: Value::Null,
        retry_after: None,
    }
}

fn commit_info(value: &Value) -> std::result::Result<CommitInfo, Failure> {
    let parents = value["parents"]
        .as_array()
        .ok_or_else(|| malformed("missing parents"))?
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or_else(|| malformed("bad parent"))
        })
        .collect::<std::result::Result<_, _>>()?;
    Ok(CommitInfo {
        commit: text(value, "commit")?,
        tree: text(value, "tree")?,
        parents,
    })
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("yoneda-cli/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| Error::new(format!("building the HTTP client: {e}")))
}

impl Api {
    /// One repository's API (`<origin>/api/v1/repos/<repo>`).
    pub fn new(origin: &str, repo: &str, token: &Token) -> Result<Self> {
        if !valid_repo_id(repo) {
            return Err(Error::usage(format!(
                "{repo:?} is not a repository id (r + 20 hex)"
            )));
        }
        Ok(Self {
            http: client()?,
            base: format!("{origin}/api/v1/repos/{repo}"),
            header: token.header(),
        })
    }

    /// Repository `repo`'s API on the same origin, with the same credential (a fork's parent).
    pub fn sibling(&self, repo: &str) -> Result<Self> {
        let parent = self.base.rsplit_once('/').map(|(p, _)| p);
        match parent {
            Some(parent) if valid_repo_id(repo) && parent.ends_with("/repos") => Ok(Self {
                http: self.http.clone(),
                base: format!("{parent}/{repo}"),
                header: self.header.clone(),
            }),
            _ => Err(Error::new(format!("{repo:?} is not a repository id"))),
        }
    }

    /// The account-level API (`<origin>/api/v1`): repositories and device login.
    /// `token` is `None` only for the device flow, which runs before there is one.
    pub fn account(origin: &str, token: Option<&Token>) -> Result<Self> {
        Ok(Self {
            http: client()?,
            base: format!("{origin}/api/v1"),
            header: token.map_or(Header::None, Token::header),
        })
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> std::result::Result<Value, Failure> {
        let mut request = self.http.request(method, format!("{}{path}", self.base));
        request = match &self.header {
            Header::Authorization(value) => request.header("authorization", value),
            Header::Cookie(value) => request.header("cookie", value),
            Header::None => request,
        };
        if let Some(body) = body {
            request = request.json(body);
        }
        let unreachable = |e: reqwest::Error| Failure {
            status: 0,
            code: "UNREACHABLE".into(),
            // reqwest errors carry the URL, never request headers.
            message: format!("cannot reach the platform: {e}"),
            details: Value::Null,
            retry_after: None,
        };
        let response = request.send().await.map_err(unreachable)?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let bytes = response.bytes().await.map_err(unreachable)?;
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            return Ok(value);
        }
        let error = &value["error"];
        Err(Failure {
            status,
            code: error["code"].as_str().unwrap_or("HTTP_ERROR").to_owned(),
            message: error["message"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("HTTP {status}")),
            details: error["details"].clone(),
            retry_after,
        })
    }

    pub async fn get(&self, path: &str) -> std::result::Result<Value, Failure> {
        self.retrying(reqwest::Method::GET, path, None).await
    }

    /// A POST that only reads (the batch object read), retried like a GET.
    pub async fn post_read(&self, path: &str, body: &Value) -> std::result::Result<Value, Failure> {
        self.retrying(reqwest::Method::POST, path, Some(body)).await
    }

    /// A write the platform applies at most once however often it is sent, retried like a
    /// read. Only for writes whose repeat is a no-op on the server: recording a commit
    /// (content-addressed, moves no ref), a compare-and-swap branch move (a repeat finds the
    /// branch at the commit and answers `already`) and a landing (`already` once landed).
    pub async fn post_idempotent(
        &self,
        path: &str,
        body: &Value,
    ) -> std::result::Result<Value, Failure> {
        self.retrying(reqwest::Method::POST, path, Some(body)).await
    }

    /// Calls that are safe to repeat: a dropped connection, a body cut off mid-stream, a
    /// gateway error or an overloaded platform is retried (four attempts, waiting the
    /// platform's `Retry-After` or 1, 2, 3 s) instead of failing a whole clone or push. An
    /// overload can follow a call that already took effect, so other writes never retry.
    async fn retrying(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> std::result::Result<Value, Failure> {
        let mut attempt = 0;
        loop {
            match self.send(method.clone(), path, body).await {
                Err(failure) if attempt < RETRIES && transient(&failure) => {
                    attempt += 1;
                    tokio::time::sleep(backoff(&failure, attempt)).await;
                }
                result => return result,
            }
        }
    }

    pub async fn post(&self, path: &str, body: &Value) -> std::result::Result<Value, Failure> {
        self.send(reqwest::Method::POST, path, Some(body)).await
    }

    pub async fn put(&self, path: &str, body: &Value) -> std::result::Result<Value, Failure> {
        self.send(reqwest::Method::PUT, path, Some(body)).await
    }

    pub async fn delete(&self, path: &str) -> std::result::Result<Value, Failure> {
        self.send(reqwest::Method::DELETE, path, None).await
    }

    /// The current log version and the branch's Git commit at it (the platform waits
    /// for landed changesets to be projected before answering).
    pub async fn branch_at_latest(
        &self,
        branch: &str,
    ) -> std::result::Result<(u64, String), Failure> {
        let refs = self.get("/refs").await?;
        let version = refs["version"]
            .as_u64()
            .ok_or_else(|| malformed("missing version"))?;
        let commit = refs["refs"][format!("refs/heads/{branch}")]
            .as_str()
            .ok_or_else(|| malformed(&format!("no branch {branch}")))?;
        Ok((version, commit.to_owned()))
    }

    pub async fn commit(&self, id: &str) -> std::result::Result<CommitInfo, Failure> {
        commit_info(&self.commit_record(id).await?)
    }

    /// A recorded commit with its message, principal and landings.
    pub async fn commit_record(&self, id: &str) -> std::result::Result<Value, Failure> {
        self.get(&format!("/commits/{id}")).await
    }

    /// Records a commit on `parent` (empty: a root commit) with extra merge parents (a local
    /// merge commit) and the files it read (`read_set`, validated when it lands). `author`
    /// may carry `time` and `tz`; with a `committer` too, the platform rebuilds the local
    /// commit exactly.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_merge_commit(
        &self,
        parent: &str,
        base_version: u64,
        changes: Vec<Value>,
        message: &str,
        author: &Value,
        committer: Option<&Value>,
        merge_parents: &[String],
        read_set: &[String],
    ) -> std::result::Result<CommitInfo, Failure> {
        let parent = Some(parent).filter(|p| !p.is_empty());
        let mut body = json!({
            "parent": parent, "base_version": base_version, "changes": changes,
            "message": message, "author": author,
        });
        if let Some(committer) = committer {
            body["committer"] = committer.clone();
        }
        if !merge_parents.is_empty() {
            body["merge_parents"] = json!(merge_parents);
        }
        if !read_set.is_empty() {
            body["read_set"] = json!(read_set);
        }
        commit_info(&self.post_idempotent("/commits", &body).await?)
    }

    /// Repository status: log version, refs table and projections (no projection wait).
    pub async fn status(&self) -> std::result::Result<Value, Failure> {
        self.get("/").await
    }

    /// A working branch's head from the refs table, or `None` when it does not exist.
    pub async fn branch_head(&self, branch: &str) -> std::result::Result<Option<String>, Failure> {
        let status = self.status().await?;
        let name = format!("refs/heads/{branch}");
        Ok(status["refs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["name"] == name.as_str())
            .and_then(|r| r["commit_id"].as_str().map(str::to_owned)))
    }

    /// Records a commit on `parent`, pinned to `base_version` for landing's path checks.
    pub async fn create_commit(
        &self,
        parent: &str,
        base_version: u64,
        changes: Vec<Value>,
        message: &str,
        author: &Value,
        committer: Option<&Value>,
    ) -> std::result::Result<CommitInfo, Failure> {
        self.create_merge_commit(
            parent,
            base_version,
            changes,
            message,
            author,
            committer,
            &[],
            &[],
        )
        .await
    }

    /// Moves a working branch by compare-and-swap on its expected old head.
    pub async fn set_branch(
        &self,
        branch: &str,
        commit: &str,
        expected: Option<&str>,
    ) -> std::result::Result<(), Failure> {
        let body = json!({ "ref": branch, "commit": commit, "expected": expected });
        self.post_idempotent("/branches", &body).await.map(|_| ())
    }

    /// Lands `commit` on `branch`; a landing still settling is submitted again.
    pub async fn land(&self, branch: &str, commit: &str) -> std::result::Result<Value, Failure> {
        let body = json!({ "ref": branch, "commit": commit });
        let mut attempt = 0;
        loop {
            match self.post_idempotent("/land", &body).await {
                Err(f) if f.code == "TIMEOUT" && attempt < 3 => attempt += 1,
                other => return other,
            }
        }
    }

    /// A file on the branch's latest version: `Ok(None)` when it does not exist.
    pub async fn file(
        &self,
        branch: &str,
        path: &str,
    ) -> std::result::Result<Option<Vec<u8>>, Failure> {
        let query = format!("/blob?ref={}&path={}", encode(branch), encode(path));
        match self.get(&query).await {
            Ok(value) => decode_file(&value).map(Some),
            Err(f) if f.code == "NOT_FOUND" => Ok(None),
            Err(f) => Err(f),
        }
    }
}

fn decode_file(value: &Value) -> std::result::Result<Vec<u8>, Failure> {
    use base64::Engine;
    let content = value["content"]
        .as_str()
        .ok_or_else(|| malformed("missing content"))?;
    match value["encoding"].as_str() {
        Some("base64") => base64::engine::general_purpose::STANDARD
            .decode(content)
            .map_err(|_| malformed("bad base64 content")),
        _ => Ok(content.as_bytes().to_vec()),
    }
}

/// Percent-encodes a query value (RFC 3986 unreserved characters pass through).
pub fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sibling_is_another_repository_on_the_same_origin() -> Result<()> {
        let fork = Api::account("https://api.example", None)?.sibling("r00000000000000000f01");
        // The account API is not a repository's: no sibling.
        assert!(fork.is_err());
        let token = crate::credentials::Token::new("yrp_secret")?;
        let fork = Api::new("https://api.example", "r00000000000000000f01", &token)?;
        let parent = fork.sibling("r00000000000000000a01")?;
        assert_eq!(
            parent.base,
            "https://api.example/api/v1/repos/r00000000000000000a01"
        );
        assert_eq!(parent.header, fork.header);
        assert!(fork.sibling("../tokens").is_err());
        Ok(())
    }

    #[test]
    fn encodes_unicode_query_values() {
        assert_eq!(encode("dir/ünï/f le&x"), "dir/%C3%BCn%C3%AF/f%20le%26x");
    }

    /// A read whose body is cut off mid-stream (seen live: "error decoding response body"
    /// during a clone) succeeds on the next attempt; a write is never repeated.
    #[tokio::test]
    async fn retries_a_read_cut_off_mid_body_and_never_a_write() -> Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| Error::new(e.to_string()))?;
        let origin = format!(
            "http://{}",
            listener
                .local_addr()
                .map_err(|e| Error::new(e.to_string()))?
        );
        let server = tokio::spawn(async move {
            let mut served = 0;
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request).await;
                served += 1;
                let reply: &[u8] = if served % 2 == 1 {
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{\"ok\""
                } else {
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{\"ok\":true}"
                };
                let _ = socket.write_all(reply).await;
                drop(socket);
            }
        });
        let api = Api::account(&origin, None)?;
        let read = api.get("/repos").await.map_err(Error::from)?;
        assert_eq!(read, json!({ "ok": true }));
        let write = api.post("/repos", &json!({})).await;
        assert!(matches!(write, Err(Failure { status: 0, .. })), "{write:?}");
        server.abort();
        Ok(())
    }

    /// An overloaded platform (503 OVERLOADED, Retry-After) is waited out for reads and for
    /// writes whose repeat is a no-op; any other write fails at once with the code.
    #[tokio::test]
    async fn retries_an_overload_for_reads_and_idempotent_writes_only() -> Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| Error::new(e.to_string()))?;
        let origin = format!(
            "http://{}",
            listener
                .local_addr()
                .map_err(|e| Error::new(e.to_string()))?
        );
        // Every other request is refused as overloaded, starting with the first.
        let server = tokio::spawn(async move {
            let mut served = 0;
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request).await;
                served += 1;
                let reply: &[u8] = if served % 2 == 1 {
                    b"HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\nretry-after: 0\r\ncontent-length: 48\r\nconnection: close\r\n\r\n{\"error\":{\"code\":\"OVERLOADED\",\"message\":\"busy\"}}"
                } else {
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{\"ok\":true}"
                };
                let _ = socket.write_all(reply).await;
                drop(socket);
            }
        });
        let api = Api::account(&origin, None)?;
        let ok = json!({ "ok": true });
        assert_eq!(api.get("/repos").await.map_err(Error::from)?, ok);
        let body = json!({ "ref": "main", "commit": "c" });
        assert_eq!(
            api.post_idempotent("/land", &body)
                .await
                .map_err(Error::from)?,
            ok
        );
        let write = api.post("/repos", &json!({})).await;
        assert!(
            matches!(&write, Err(Failure { status: 503, code, retry_after: Some(0), .. }) if code == "OVERLOADED"),
            "{write:?}"
        );
        server.abort();
        Ok(())
    }

    #[test]
    fn checks_repository_ids() {
        assert!(valid_repo_id("r59a3be26f77ad32a17ea"));
        assert!(!valid_repo_id("r59a3be26f77ad32a17e/"));
        assert!(!valid_repo_id("../etc"));
    }
}
