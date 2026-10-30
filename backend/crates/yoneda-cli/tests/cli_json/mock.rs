//! A canned platform on a local port: one fixed JSON answer per `METHOD /path` (the path
//! after `/api/v1`, query dropped), enough for each `yoneda` command to print a result.
//! Everything it serves is a labelled test fixture, not data from a real repository.
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

pub const REPO: &str = "r0123456789abcdef0123";
pub const FORK: &str = "rfedcba9876543210fedc";
pub const COMMIT: &str = "cccccccccccccccccccccccccccccccccccccccc";
/// A head whose landing the fixture refuses with a conflict.
pub const CLASH: &str = "dddddddddddddddddddddddddddddddddddddddd";

/// Starts the fixture platform; returns its origin (`http://127.0.0.1:<port>`).
pub fn start() -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let origin = format!(
        "http://{}",
        listener.local_addr().map_err(|e| e.to_string())?
    );
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = serve(stream);
        }
    });
    Ok(origin)
}

fn serve(mut stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        if header.trim().is_empty() {
            break;
        }
        if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let path = target.split('?').next().unwrap_or_default();
    let path = path.strip_prefix("/api/v1").unwrap_or(path);
    let (status, reply) = answer(method, path, &String::from_utf8_lossy(&body));
    let text = reply.to_string();
    write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    )
}

pub fn change() -> Value {
    json!({
        "number": 3, "status": "open", "title": "Retry twice", "branch": "topic",
        "base": "main", "author": "alice", "head": COMMIT, "body": "why",
        "head_commit": {
            "gates": { "ready": false, "approvals": 0, "approvals_required": 1,
                       "rejected": false, "missing_checks": ["ci"], "failing_checks": [] },
            "reviews": [{ "decision": "approve", "principal": "bob", "reason": null }],
        },
        "diff": { "changes": [{ "op": "modify", "path": "src/a.rs" }] },
        "comments": [{ "principal": "bob", "path": "src/a.rs", "line": 7, "side": "new",
                       "resolved_at": null, "body": "nit" }],
    })
}

pub fn release() -> Value {
    json!({
        "tag": "v1", "title": "First", "commit_id": COMMIT, "created_by": "alice",
        "asset_count": 1, "notes": "", "annotated": null,
        "assets": [{ "name": "app.zip", "size": 3, "sha256": "ab" }],
    })
}

pub fn status() -> Value {
    json!({
        "version": 9,
        "refs": [
            { "name": "refs/heads/main", "commit_id": COMMIT, "version": 9 },
            { "name": "refs/heads/topic", "commit_id": COMMIT, "version": 8 },
            { "name": "refs/heads/clash", "commit_id": CLASH, "version": 8 },
        ],
        "policy": { "approvals": 0, "required_checks": [] },
    })
}

pub fn commit_record() -> Value {
    json!({ "commit": COMMIT, "checks": {}, "check_runs": [], "gates": { "ready": true } })
}

pub fn check_run() -> Value {
    json!({ "id": "run1", "name": "lint", "status": "queued" })
}

pub fn tokens() -> Value {
    json!({ "tokens": [{ "name": "ci", "scopes": ["read"] }] })
}

pub fn blame() -> Value {
    json!({ "path": "src/a.rs", "lines": [{ "line": 1, "commit": COMMIT }] })
}

pub fn symbols() -> Value {
    json!({ "path": "src/a.rs", "symbols": [{ "name": "main", "kind": "fn", "line": 1 }] })
}

pub fn org() -> Value {
    json!({
        "org": "acme", "role": "owner", "created_by": "alice",
        "members": [{ "account": "alice", "role": "owner" }],
        "teams": [{ "name": "devs", "members": ["alice"] }],
    })
}

fn error(status: &'static str, code: &str, message: &str, details: Value) -> (&'static str, Value) {
    let body = json!({ "error": { "code": code, "message": message, "details": details } });
    (status, body)
}

fn answer(method: &str, path: &str, body: &str) -> (&'static str, Value) {
    let ok = |value: Value| ("200 OK", value);
    let repo = format!("/repos/{REPO}");
    let local = path.strip_prefix(repo.as_str());
    match (method, local.unwrap_or(path)) {
        // Repository API.
        ("GET", "" | "/") if local.is_some() => ok(status()),
        ("POST", "/tokens") => ok(json!({ "token": "ydr_fixture_secret" })),
        ("GET", "/tokens") => ok(tokens()),
        ("DELETE", "/tokens/ci") => ok(json!({})),
        ("POST", p) if p == format!("/commits/{COMMIT}/check-runs") => ok(check_run()),
        ("GET", "/check-runs/run1") => ok(check_run()),
        ("GET", p) if p == format!("/commits/{COMMIT}") => ok(commit_record()),
        ("POST", p) if p == format!("/commits/{COMMIT}/reviews") => ok(json!({})),
        ("POST", p) if p == format!("/commits/{COMMIT}/sessions") => ok(json!({ "session": 5 })),
        ("GET", p) if p == format!("/commits/{COMMIT}/sessions") => ok(json!({ "sessions": [
            { "cli": "codex", "model": "gpt", "recorded_by": "alice", "summary": "done" }] })),
        ("GET", "/log") => ok(json!({ "commits": [
            { "commit": COMMIT, "message": "first\nbody", "landed": { "version": 3 } }] })),
        ("GET", "/search") => ok(json!({ "results": [
            { "path": "src/a.rs", "lines": [{ "line": 3, "text": "fn main" }] }] })),
        ("GET", "/blame") => ok(blame()),
        ("GET", "/diff") => ok(json!({ "changes": [
            { "path": "a.txt", "status": "M", "patch": "--- a/a.txt\n+++ b/a.txt\n" },
            { "path": "b.txt", "status": "D" }] })),
        ("GET", "/symbols") => ok(symbols()),
        ("GET", "/refs") => ok(json!({ "version": 9, "refs": { "refs/heads/main": COMMIT } })),
        ("POST", "/land") if body.contains(CLASH) => error(
            "409 Conflict",
            "CONFLICT",
            "both sides changed src/a.rs",
            json!({ "conflicts": [{ "path": "src/a.rs" }] }),
        ),
        ("POST", "/land") => ok(json!({ "version": 9 })),
        ("POST", "/branches/topic/rebase") => ok(json!({ "commits": ["x"], "head": COMMIT })),
        ("PUT", "/policy") => ok(json!({ "policy": { "approvals": 1 } })),
        ("POST", "/changes") => ok(change()),
        ("GET", "/changes") => ok(json!({ "changes": [change()] })),
        ("GET", "/changes/3") => ok(change()),
        ("POST", "/changes/3/comments") => ok(json!({ "comment": { "id": 1 }, "resolved": 0 })),
        ("GET", "/releases") => ok(json!({ "releases": [release()] })),
        ("GET", "/releases/v1") => ok(release()),
        ("POST", "/releases") => ok(release()),
        ("PUT", "/releases/v1/assets/app.zip") => {
            ok(json!({ "name": "app.zip", "size": 3, "sha256": "ab" }))
        }
        ("GET", "/context") => ok(json!({ "main": { "head": COMMIT, "version": 9 } })),
        // Account API.
        ("GET", "/repos") => ok(json!({ "repos": [{ "id": REPO, "name": "demo",
            "visibility": "private", "created_at": 1_700_000_000_000_i64 }] })),
        ("POST", "/repos") => ok(json!({ "id": REPO })),
        ("PUT", "/visibility") => ok(json!({})),
        ("DELETE", "") => ok(json!({})),
        ("POST", "/fork") => ok(json!({ "id": FORK, "name": "mine", "parent_version": 7,
            "refs": 2, "commits": 5 })),
        ("GET", "/orgs") => ok(json!({ "orgs": [{ "org": "acme", "role": "owner" }] })),
        ("POST", "/orgs") => ok(json!({})),
        ("GET", "/orgs/acme") => ok(org()),
        ("GET", "/orgs/nobody") => error(
            "404 Not Found",
            "NOT_FOUND",
            "no such organization",
            Value::Null,
        ),
        ("GET", "/orgs/acme/repos") => ok(json!({ "repos": [{ "id": REPO, "name": "demo" }] })),
        ("DELETE", "/orgs/acme")
        | ("POST", "/orgs/acme/members" | "/orgs/acme/teams" | "/orgs/acme/teams/devs/members")
        | (
            "DELETE",
            "/orgs/acme/members/bob"
            | "/orgs/acme/teams/devs"
            | "/orgs/acme/teams/devs/members/bob",
        ) => ok(json!({})),
        ("POST", "/ssh-keys") => ok(json!({ "id": "k1", "fingerprint": "SHA256:abc",
            "title": "ci", "ssh": { "host": "ssh.example" } })),
        ("GET", "/ssh-keys") => ok(json!({ "keys": [{ "id": "k1", "fingerprint": "SHA256:abc",
            "title": "ci", "last_used_at": null }],
            "ssh": { "front_door": "tunnel", "host": "ssh.example",
                     "ssh_config": "Host ssh.example\n  ProxyCommand cloudflared access ssh --hostname %h\n" } })),
        ("DELETE", "/ssh-keys/k1") => ok(json!({})),
        _ => error(
            "404 Not Found",
            "NOT_FOUND",
            &format!("no fixture for {method} {path}"),
            Value::Null,
        ),
    }
}
