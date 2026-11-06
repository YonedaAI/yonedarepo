//! Fetch and clone: Git's own `git http-backend` (CGI) over the store, so upload-pack,
//! protocol v2, partial and shallow clones and gzip request bodies are exactly Git's. Refs
//! it serves are the authority's, projected; hidden commit refs are not advertised.
use crate::layout::local_error;
use crate::store::Store;
use std::io::Write;
use std::process::{Command, Stdio};
use yoneda_core::Result;

pub struct Answer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub struct Request<'a> {
    pub method: &'a str,
    /// `info/refs` or `git-upload-pack`.
    pub action: &'a str,
    pub query: &'a str,
    pub content_type: Option<&'a str>,
    pub content_encoding: Option<&'a str>,
    pub git_protocol: Option<&'a str>,
    pub body: &'a [u8],
}

pub fn serve(store: &Store, req: &Request) -> Result<Answer> {
    let root = store.path.parent().unwrap_or(&store.path);
    let name = store
        .path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("store.git");
    let mut cmd = Command::new(crate::store::git_bin());
    cmd.arg("http-backend")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_PROJECT_ROOT", root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("PATH_INFO", format!("/{name}/{}", req.action))
        .env("REQUEST_METHOD", req.method)
        .env("QUERY_STRING", req.query)
        .env("CONTENT_LENGTH", req.body.len().to_string())
        .env("REMOTE_ADDR", "127.0.0.1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(t) = req.content_type {
        cmd.env("CONTENT_TYPE", t);
    }
    if let Some(e) = req.content_encoding {
        cmd.env("HTTP_CONTENT_ENCODING", e);
    }
    if let Some(p) = req.git_protocol {
        cmd.env("GIT_PROTOCOL", p);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| local_error(format!("Cannot run git http-backend: {e}")))?;
    let mut stdin = child.stdin.take();
    let body = req.body.to_vec();
    let writer = std::thread::spawn(move || {
        if let Some(pipe) = stdin.as_mut() {
            let _ = pipe.write_all(&body);
        }
    });
    let out = child
        .wait_with_output()
        .map_err(|e| local_error(format!("git http-backend failed: {e}")))?;
    let _ = writer.join();
    parse(&out.stdout)
}

/// A CGI answer: headers (with an optional `Status:`), a blank line, the body.
fn parse(out: &[u8]) -> Result<Answer> {
    let split = out
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|p| (p, p + 4))
        .or_else(|| {
            out.windows(2)
                .position(|w| w == b"\n\n")
                .map(|p| (p, p + 2))
        })
        .ok_or_else(|| local_error("git http-backend answered without headers"))?;
    let mut status = 200;
    let mut headers = Vec::new();
    for line in String::from_utf8_lossy(&out[..split.0]).lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().to_owned();
        if name.eq_ignore_ascii_case("status") {
            status = value
                .split(' ')
                .next()
                .and_then(|s| s.parse().ok())
                .unwrap_or(500);
        } else {
            headers.push((name.to_owned(), value));
        }
    }
    Ok(Answer {
        status,
        headers,
        body: out[split.1..].to_vec(),
    })
}
