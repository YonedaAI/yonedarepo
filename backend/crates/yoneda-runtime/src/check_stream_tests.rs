//! The streamed check request: frames split anywhere still give the exact files, a body cut
//! short or oversized is refused before anything runs, and the server takes it with its
//! bearer secret only.
use crate::check_stream::{MAGIC, run_stream};
use serde_json::{Value, json};

/// A streamed request: header, then (kind, path, content) frames, then the end byte.
fn body(command: &[&str], files: &[(u8, &str, &[u8])], end: bool) -> Vec<u8> {
    let header = json!({"command": command, "timeout_seconds": 10}).to_string();
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&u32::try_from(header.len()).unwrap().to_be_bytes());
    out.extend_from_slice(header.as_bytes());
    for (kind, path, data) in files {
        out.push(*kind);
        out.extend_from_slice(&u16::try_from(path.len()).unwrap().to_be_bytes());
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
        out.extend_from_slice(data);
    }
    if end {
        out.push(0);
    }
    out
}

/// `bytes` as a body arriving in chunks of `size`.
fn chunks(
    bytes: Vec<u8>,
    size: usize,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Unpin {
    let parts: Vec<Result<bytes::Bytes, std::io::Error>> = bytes
        .chunks(size)
        .map(|c| Ok(bytes::Bytes::copy_from_slice(c)))
        .collect();
    futures_util::stream::iter(parts)
}

async fn streamed(bytes: Vec<u8>, size: usize) -> yoneda_core::Result<Value> {
    run_stream(chunks(bytes, size), std::time::Instant::now()).await
}

const SCRIPT: &[u8] =
    b"#!/bin/sh\ntest \"$(cat src/a.txt)\" = alpha && test -L link && echo verified\n";

#[tokio::test]
async fn files_split_at_any_byte_arrive_exact_and_run() {
    let files: [(u8, &str, &[u8]); 3] = [
        (1, "src/a.txt", b"alpha"),
        (2, "run.sh", SCRIPT),
        (3, "link", b"src/a.txt"),
    ];
    for size in [1, 2, 7, 64, 1 << 20] {
        let result = streamed(body(&["./run.sh"], &files, true), size)
            .await
            .unwrap();
        assert_eq!(result["outcome"], "pass", "chunks of {size}: {result}");
        assert!(result["output_tail"].as_str().unwrap().contains("verified"));
        assert_eq!(
            (result["files"].as_u64(), result["file_bytes"].as_u64()),
            (Some(3), Some((5 + SCRIPT.len() + 9) as u64))
        );
        assert!(result["setup_ms"].is_u64());
    }
}

#[tokio::test]
async fn refuses_cut_bad_oversized_or_unsafe_requests() {
    let code = |r: yoneda_core::Result<Value>| r.unwrap_err().code;
    let files: [(u8, &str, &[u8]); 1] = [(1, "a.txt", b"a")];
    // Cut before the end byte: nothing runs on a partial tree.
    assert_eq!(
        code(streamed(body(&["true"], &files, false), 3).await),
        "INVALID_INPUT"
    );
    let mut bad = body(&["true"], &files, true);
    bad[0] = b'X';
    assert_eq!(code(streamed(bad, 64).await), "INVALID_INPUT");
    // A content length over the size bound is refused from its frame header alone.
    let mut huge = body(&["true"], &[], false);
    huge.extend_from_slice(&[1, 0, 1, b'h']);
    huge.extend_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(code(streamed(huge, 64).await), "INVALID_INPUT");
    let twice: [(u8, &str, &[u8]); 2] = [(1, "a.txt", b"a"), (1, "a.txt", b"b")];
    assert_eq!(
        code(streamed(body(&["true"], &twice, true), 64).await),
        "INVALID_INPUT"
    );
    for path in ["../out", "/abs", ".git/config"] {
        let escaping: [(u8, &str, &[u8]); 1] = [(1, path, b"x")];
        assert!(
            streamed(body(&["true"], &escaping, true), 64)
                .await
                .is_err(),
            "{path}"
        );
    }
    let outside: [(u8, &str, &[u8]); 1] = [(3, "link", b"../../etc/passwd")];
    assert_eq!(
        code(streamed(body(&["true"], &outside, true), 64).await),
        "INVALID_INPUT"
    );
    let unknown: [(u8, &str, &[u8]); 1] = [(9, "a", b"x")];
    assert_eq!(
        code(streamed(body(&["true"], &unknown, true), 64).await),
        "INVALID_INPUT"
    );
}

#[tokio::test]
async fn the_server_takes_a_streamed_check_with_its_secret_only() {
    let app = crate::check_server::router("s3cret".into());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let request = body(
        &["sh", "-c", "test \"$(cat a.txt)\" = a"],
        &[(1, "a.txt", b"a")],
        true,
    );
    let url = format!("http://{address}/check/stream");
    let denied = client
        .post(&url)
        .body(request.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    let ok = client
        .post(&url)
        .bearer_auth("s3cret")
        .body(request)
        .send()
        .await
        .unwrap();
    assert_eq!(ok.json::<Value>().await.unwrap()["outcome"], "pass");
}
