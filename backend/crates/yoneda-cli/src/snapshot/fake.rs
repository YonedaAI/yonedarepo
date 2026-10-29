//! A fault-injecting platform stand-in for the object transfer tests: every request is
//! recorded, and a reply can be delayed or cut off part way through its body (the
//! connection drops before the announced content-length arrives).
use crate::error::{Error, Result};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// One request the fake received.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub range: Option<String>,
    /// The object ids a `POST /objects` asked for, in order.
    pub ids: Vec<String>,
}

/// The fake's answer to one request.
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// Body bytes sent before the connection drops (`None`: all of them).
    pub cut_at: Option<usize>,
    pub delay_ms: u64,
}

impl Reply {
    pub fn ok(kind: &str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".into(), kind.into())],
            body,
            cut_at: None,
            delay_ms: 0,
        }
    }

    pub fn cut(mut self, at: usize) -> Self {
        self.cut_at = Some(at);
        self
    }
}

/// Requests seen so far, and the body bytes actually sent per request.
pub type Log = Arc<Mutex<Vec<(Seen, usize)>>>;

/// Starts the fake; `answer` gets each request and every earlier one (oldest first).
pub async fn serve<F>(answer: F) -> Result<(String, Log)>
where
    F: Fn(&Seen, &[Seen]) -> Reply + Send + Sync + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| Error::new(e.to_string()))?;
    let origin = format!(
        "http://{}",
        listener
            .local_addr()
            .map_err(|e| Error::new(e.to_string()))?
    );
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let seen = log.clone();
    let answer = Arc::new(answer);
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let seen = seen.clone();
            let answer = answer.clone();
            tokio::spawn(async move {
                let Some(request) = read_request(&mut socket).await else {
                    return;
                };
                let (reply, index) = {
                    let Ok(mut log) = seen.lock() else { return };
                    let earlier: Vec<Seen> = log.iter().map(|(s, _)| s.clone()).collect();
                    let reply = answer(&request, &earlier);
                    log.push((request, 0));
                    (reply, log.len() - 1)
                };
                if reply.delay_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(reply.delay_ms)).await;
                }
                let sent = reply
                    .cut_at
                    .unwrap_or(reply.body.len())
                    .min(reply.body.len());
                let mut head = format!(
                    "HTTP/1.1 {} X\r\ncontent-length: {}\r\nconnection: close\r\n",
                    reply.status,
                    reply.body.len()
                );
                for (name, value) in &reply.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&reply.body[..sent]).await;
                let _ = socket.flush().await;
                if let Ok(mut log) = seen.lock()
                    && let Some(entry) = log.get_mut(index)
                {
                    entry.1 = sent;
                }
                // Dropping the socket short of content-length is the cut.
            });
        }
    });
    Ok((origin, log))
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<Seen> {
    let mut request = Vec::new();
    let mut chunk = [0u8; 16384];
    let (head, body) = loop {
        let n = socket.read(&mut chunk).await.ok()?;
        request.extend_from_slice(&chunk[..n]);
        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&request[..end]).to_string();
            let length = header(&head, "content-length")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(0);
            while request.len() < end + 4 + length {
                let n = socket.read(&mut chunk).await.ok()?;
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..n]);
            }
            break (head, request[end + 4..].to_vec());
        }
        if n == 0 {
            return None;
        }
    };
    let mut line = head.lines().next()?.split(' ');
    let method = line.next()?.to_owned();
    let path = line.next()?.to_owned();
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let ids = body["objects"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| o["id"].as_str().map(str::to_owned))
        .collect();
    Some(Seen {
        method,
        path,
        range: header(&head, "range"),
        ids,
    })
}

fn header(head: &str, name: &str) -> Option<String> {
    head.lines().find_map(|l| {
        let (key, value) = l.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(name)
            .then(|| value.trim().to_owned())
    })
}

/// A page as the platform writes it (JavaScript key order: `objects` first).
pub fn page(objects: &[Value], missing: &[String]) -> Vec<u8> {
    let objects: Vec<String> = objects.iter().map(Value::to_string).collect();
    format!(
        "{{\"objects\":[{}],\"missing\":{},\"next\":null}}",
        objects.join(","),
        Value::from(missing.to_vec())
    )
    .into_bytes()
}
