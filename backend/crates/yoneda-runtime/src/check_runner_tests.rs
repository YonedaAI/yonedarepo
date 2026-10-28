//! Check executor: real processes on the exact files, bounded evidence, hard timeouts.
use crate::check_runner::{CheckFile, CheckRequest, run};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;

fn file(path: &str, kind: &str, data: &str) -> CheckFile {
    CheckFile {
        path: path.into(),
        kind: kind.into(),
        data_b64: STANDARD.encode(data),
    }
}
fn request(command: &[&str], timeout_seconds: u64, files: Vec<CheckFile>) -> CheckRequest {
    CheckRequest {
        command: command.iter().map(|s| (*s).into()).collect(),
        timeout_seconds,
        files,
    }
}
async fn check(command: &[&str], files: Vec<CheckFile>) -> Value {
    run(request(command, 20, files)).await.unwrap()
}

#[tokio::test]
async fn runs_the_exact_files_and_reports_pass_or_fail() {
    let files = || {
        vec![
            file("src/a.txt", "blob", "alpha\n"),
            file(
                "run.sh",
                "exec",
                "#!/bin/sh\ntest \"$(cat src/a.txt)\" = alpha && echo verified\n",
            ),
        ]
    };
    let passed = check(&["./run.sh"], files()).await;
    assert_eq!(passed["outcome"], "pass");
    assert_eq!(passed["exit_code"], 0);
    assert!(passed["output_tail"].as_str().unwrap().contains("verified"));
    let failed = check(&["sh", "-c", "echo boom >&2; exit 3"], files()).await;
    assert_eq!(
        (failed["outcome"].as_str(), failed["exit_code"].as_i64()),
        (Some("fail"), Some(3))
    );
    assert!(failed["output_tail"].as_str().unwrap().contains("boom"));
    assert_eq!(failed["output_sha256"].as_str().unwrap().len(), 64);
}

#[tokio::test]
async fn timeouts_kill_the_whole_process_group() {
    let started = std::time::Instant::now();
    let result = run(request(&["sh", "-c", "sleep 30 & sleep 30"], 1, vec![]))
        .await
        .unwrap();
    assert_eq!(result["timed_out"], true);
    assert_eq!(result["outcome"], "fail");
    assert!(
        started.elapsed().as_secs() < 10,
        "background children must not hold the check open"
    );
}

#[tokio::test]
async fn keeps_only_a_bounded_tail_of_output() {
    let result = check(
        &[
            "sh",
            "-c",
            "head -c 300000 /dev/zero | tr '\\0' x; echo END",
        ],
        vec![],
    )
    .await;
    assert_eq!(result["output_bytes"], 300_004);
    let tail = result["output_tail"].as_str().unwrap();
    assert!(tail.len() <= 64 * 1024 && tail.ends_with("END\n"));
}

#[tokio::test]
async fn scrubs_the_environment() {
    // SAFETY: test-local variable; the check must not inherit runtime secrets.
    unsafe { std::env::set_var("CHECK_TOKEN", "runtime-secret") };
    let result = check(
        &[
            "sh",
            "-c",
            "test -z \"$CHECK_TOKEN\" && test \"$CI\" = true",
        ],
        vec![],
    )
    .await;
    assert_eq!(result["outcome"], "pass");
}

#[tokio::test]
async fn rejects_escaping_or_duplicate_paths_and_bad_limits() {
    for files in [
        vec![file("../x", "blob", "")],
        vec![file(".git/config", "blob", "")],
        vec![file("/etc/x", "blob", "")],
        vec![file("a", "blob", ""), file("a", "blob", "")],
        vec![file("a", "tree", "")],
    ] {
        let code = run(request(&["true"], 5, files)).await.unwrap_err().code;
        assert!(
            ["INVALID_INPUT", "UNSAFE_PATH"].contains(&code.as_str()),
            "{code}"
        );
    }
    assert!(run(request(&["true"], 0, vec![])).await.is_err());
    assert_eq!(
        run(request(&["/no/such/binary"], 5, vec![]))
            .await
            .unwrap_err()
            .code,
        "CHECK_START"
    );
}

#[tokio::test]
async fn keeps_symlinks_inside_the_root() {
    for (files, code) in [
        (vec![file("link", "symlink", "../../etc/passwd")], "INVALID_INPUT"),
        (vec![file("link", "symlink", "/etc/passwd")], "INVALID_INPUT"),
        (vec![file("link", "symlink", "")], "INVALID_INPUT"),
        (
            // Defense in depth: a tree cannot pair `foo` with `foo/x`, but the writer
            // refuses to follow a symlink an earlier entry planted either way.
            vec![file("foo", "symlink", "bar"), file("foo/x", "blob", "")],
            "INVALID_INPUT",
        ),
    ] {
        let error = run(request(&["true"], 5, files)).await.unwrap_err();
        assert_eq!(error.code, code, "{}", error.message);
    }
    // A target that resolves back inside the root is a plain tree entry.
    let kept = run(request(
        &["true"],
        5,
        vec![
            file("peer", "blob", "x"),
            file("dir/up", "symlink", "../peer"),
        ],
    ))
    .await
    .unwrap();
    assert_eq!(kept["outcome"], "pass");
}

#[tokio::test]
async fn server_requires_its_bearer_secret() {
    let app = crate::check_server::router("s3cret".into());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let body = serde_json::json!({"command": ["true"], "timeout_seconds": 5, "files": []});
    let denied = client
        .post(format!("http://{address}/check"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    let ok = client
        .post(format!("http://{address}/check"))
        .bearer_auth("s3cret")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(ok.json::<Value>().await.unwrap()["outcome"], "pass");
}
