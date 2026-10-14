//! Actual local smart-HTTP CGI Git receiver, not a mocked queue/provider.
use crate::{
    source_git::SourceGitObjects,
    source_git_http::SourceGitHttp,
    source_git_tree::{TreeEntry, encode_tree},
};
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{Request, Response},
    routing::any,
};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub(crate) struct Server {
    pub root: tempfile::TempDir,
    pub url: String,
    pub lose_ack: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub(crate) fn git(root: &std::path::Path, args: &[&str], bytes: &[u8]) -> Vec<u8> {
    let mut c = Command::new("/usr/bin/git")
        .current_dir(root)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    c.stdin.take().unwrap().write_all(bytes).unwrap();
    let o = c.wait_with_output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    o.stdout
}
pub(crate) fn oid(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap().trim().into()
}
async fn cgi(
    State((root, lose)): State<(PathBuf, Arc<AtomicBool>)>,
    request: Request<Body>,
) -> Response<Body> {
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let content_type = request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = axum::body::to_bytes(request.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    if path.ends_with("/git-receive-pack") {
        std::fs::write(root.join("received.request"), &bytes).unwrap();
    }
    let output = tokio::task::spawn_blocking(move || {
        let mut child = Command::new("/usr/bin/git")
            .arg("http-backend")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_PROJECT_ROOT", root)
            .env("GIT_HTTP_EXPORT_ALL", "1")
            .env("REQUEST_METHOD", method)
            .env("PATH_INFO", &path)
            .env("QUERY_STRING", query)
            .env("CONTENT_TYPE", content_type)
            .env("CONTENT_LENGTH", bytes.len().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&bytes).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        out.stdout
    })
    .await
    .unwrap();
    let boundary = output.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let mut response = Response::builder().status(200);
    for header in String::from_utf8_lossy(&output[..boundary]).lines() {
        let (name, value) = header.split_once(':').unwrap();
        if name.eq_ignore_ascii_case("status") {
            response = response.status(
                value
                    .split_whitespace()
                    .next()
                    .unwrap()
                    .parse::<u16>()
                    .unwrap(),
            );
        } else {
            response = response.header(name, value.trim());
        }
    }
    if request_path_receive(&output) && lose.swap(false, Ordering::SeqCst) {
        return Response::builder()
            .status(502)
            .body(Body::from("ACK deliberately lost after real Git commit"))
            .unwrap();
    }
    response
        .body(Body::from(output[boundary + 4..].to_vec()))
        .unwrap()
}
fn request_path_receive(output: &[u8]) -> bool {
    String::from_utf8_lossy(output).contains("application/x-git-receive-pack-result")
}
pub(crate) async fn server() -> (Server, String, String) {
    let root = tempfile::tempdir().unwrap();
    let dest = root.path().join("fork.git");
    std::fs::create_dir(&dest).unwrap();
    git(&dest, &["init", "--bare", "--object-format=sha1"], b"");
    git(&dest, &["config", "http.receivepack", "true"], b"");
    let blob = oid(git(&dest, &["hash-object", "-w", "--stdin"], b"untouched"));
    let tree = oid(git(
        &dest,
        &["hash-object", "-w", "--stdin", "-t", "tree"],
        &encode_tree(&[TreeEntry {
            name: "base".into(),
            mode: 0o100644,
            oid: blob,
        }])
        .unwrap(),
    ));
    let commit=oid(git(&dest,&["hash-object","-w","--stdin","-t","commit"],format!("tree {tree}\nauthor Test <test@invalid> 0 +0000\ncommitter Test <test@invalid> 0 +0000\n\nbase\n").as_bytes()));
    git(&dest, &["update-ref", "refs/heads/main", &commit], b"");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let lose = Arc::new(AtomicBool::new(false));
    let app = Router::new()
        .route("/{*path}", any(cgi))
        .with_state((root.path().to_path_buf(), lose.clone()));
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (
        Server {
            root,
            url: format!("http://{address}/fork.git"),
            lose_ack: lose,
            task,
        },
        commit,
        tree,
    )
}

#[tokio::test]
async fn real_smart_http_packs_only_changes_and_recovers_lost_ack_with_stable_ids() {
    let (s, base, _) = server().await;
    let mut objects = SourceGitObjects::create(&s.root.path().join("capture")).unwrap();
    let blob = objects.write("blob", b"new\0\xff").unwrap();
    let tree = objects
        .write(
            "tree",
            &encode_tree(&[TreeEntry {
                name: "binary".into(),
                mode: 0o100755,
                oid: blob,
            }])
            .unwrap(),
        )
        .unwrap();
    let commit = objects
        .commit(&tree, std::slice::from_ref(&base), "sealed")
        .unwrap();
    let pack = objects.pack(1024 * 1024).unwrap();
    s.lose_ack.store(true, Ordering::SeqCst);
    let client = SourceGitHttp::new(&s.url, None).unwrap();
    let outcome = client
        .push(&base, &commit, &pack, 1024 * 1024)
        .await
        .unwrap();
    assert!(outcome.recovered_ack && outcome.uploaded);
    let again = client
        .push(&base, &commit, &pack, 1024 * 1024)
        .await
        .unwrap();
    assert!(
        again.recovered_ack && !again.uploaded,
        "stable retry does not push again"
    );
    let dest = s.root.path().join("fork.git");
    assert_eq!(
        oid(git(&dest, &["rev-parse", "refs/heads/main^{tree}"], b"")),
        tree
    );
    assert_eq!(
        oid(git(&dest, &["rev-parse", "refs/heads/main^"], b"")),
        base
    );
}

#[tokio::test]
async fn smart_http_rejects_stale_expected_base_before_upload() {
    let (s, base, _) = server().await;
    let client = SourceGitHttp::new(&s.url, None).unwrap();
    assert!(
        client
            .push(
                &"f".repeat(40),
                &"e".repeat(40),
                &s.root.path().join("does-not-exist"),
                1024
            )
            .await
            .is_err()
    );
    assert_eq!(
        oid(git(
            &s.root.path().join("fork.git"),
            &["rev-parse", "refs/heads/main"],
            b""
        )),
        base
    );
    assert!(SourceGitHttp::new("http://example.com/fork", None).is_err());
    assert!(SourceGitHttp::new("https://user:password@example.com/fork", None).is_err());
}

#[tokio::test]
async fn nondefault_capture_ref_uses_frozen_fork_head_not_source_parent() {
    let (s, base, tree) = server().await;
    let dest = s.root.path().join("fork.git");
    let mut objects = SourceGitObjects::create(&s.root.path().join("nondefault")).unwrap();
    let fork_head=oid(git(&dest,&["hash-object","-w","--stdin","-t","commit"],format!("tree {tree}\nparent {base}\nauthor Test <test@invalid> 1 +0000\ncommitter Test <test@invalid> 1 +0000\n\nfork head\n").as_bytes()));
    git(
        &dest,
        &["update-ref", "refs/heads/working/review", &fork_head],
        b"",
    );
    let commit = objects
        .commit(&tree, std::slice::from_ref(&base), "sealed working base")
        .unwrap();
    let pack = objects.pack(1024 * 1024).unwrap();
    let client = SourceGitHttp::new(&s.url, None).unwrap();
    assert!(
        client
            .push_ref(
                "refs/heads/working/review",
                &base,
                &commit,
                &pack,
                1024 * 1024
            )
            .await
            .is_err()
    );
    client
        .push_ref(
            "refs/heads/working/review",
            &fork_head,
            &commit,
            &pack,
            1024 * 1024,
        )
        .await
        .unwrap();
    assert_eq!(
        oid(git(&dest, &["rev-parse", "refs/heads/working/review"], b"")),
        commit
    );
    assert_eq!(oid(git(&dest, &["rev-parse", "main"], b"")), base);
    assert_eq!(
        oid(git(&dest, &["rev-parse", &format!("{commit}^")], b"")),
        base
    );
    assert!(
        client
            .push_ref("refs/tags/main", &base, &commit, &pack, 1024 * 1024)
            .await
            .is_err()
    );
}
