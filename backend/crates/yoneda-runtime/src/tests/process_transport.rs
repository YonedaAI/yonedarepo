use serde_json::json;
use tokio::process::Command;

#[tokio::test]
async fn stdin_prompt_exceeding_linux_single_argument_limit_is_delivered_exactly() {
    let prompt = "🦀 approved brief\n".repeat(20_000);
    assert!(prompt.len() > 128 * 1024);
    let mut child = Command::new("/bin/sh");
    child.args(["-c", "cat; printf 'stderr drained' >&2"]);
    let transcript = crate::agent_transcript::Transcript::default();
    let output = crate::process::captured_output_with_input(&mut child, &transcript, Some(&prompt))
        .await
        .unwrap();
    assert_eq!(output["exit"], 0);
    assert_eq!(output["stdout"], prompt);
    assert_eq!(output["stderr"], "stderr drained");
}

#[tokio::test]
async fn oversized_stdin_is_rejected_before_launching_the_harness() {
    let mut child = Command::new("missing-command-must-never-be-spawned");
    let error = crate::process::captured_output_with_input(
        &mut child,
        &crate::agent_transcript::Transcript::default(),
        Some(&"x".repeat(crate::report::REPORT_LIMIT + 1)),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "PROMPT_LIMIT");
}

// This helper process supplies its own environment without unsafe concurrent set_var().
#[tokio::test]
async fn node_certificate_fixture() {
    if std::env::var("YONEDA_CERTIFICATE_FIXTURE").as_deref() != Ok("1") {
        return;
    }
    let mut child = Command::new("/bin/sh");
    crate::process::untrusted(&mut child, std::path::Path::new("/tmp"));
    child.args([
        "-c",
        "printf '%s:%s' \"$NODE_EXTRA_CA_CERTS\" \"${SUPERVISOR_TOKEN-unset}\"",
    ]);
    let output = child.output().await.unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "/etc/cloudflare/certs/cloudflare-containers-ca.crt:unset"
    );
}

#[tokio::test]
async fn node_extra_ca_survives_env_clear_without_supervisor_capability() {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::process_transport::node_certificate_fixture",
            "--nocapture",
        ])
        .env("YONEDA_CERTIFICATE_FIXTURE", "1")
        .env(
            "NODE_EXTRA_CA_CERTS",
            "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
        )
        .env("SUPERVISOR_TOKEN", "synthetic-supervisor-secret")
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[tokio::test]
async fn rejected_completion_reports_failure_with_original_retry_policy() {
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = calls.clone();
    let result = crate::supervisor_task::report_completion(
        json!({"commit":"captured"}),
        false,
        true,
        move |path, body, trusted| {
            observed.lock().unwrap().push((path, body, trusted));
            async move {
                if path == "/complete" {
                    Err(yoneda_core::Error::new(
                        "INVALID_CAPTURE",
                        "Synthetic rejection",
                    ))
                } else {
                    Ok(json!({"status":"failed"}))
                }
            }
        },
    )
    .await
    .unwrap();
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, "/complete");
    assert_eq!(calls[1].0, "/failed");
    assert_eq!(calls[1].1["retryable"], true);
    assert!(
        calls[1].1["error"]
            .as_str()
            .unwrap()
            .contains("INVALID_CAPTURE")
    );
    assert!(calls.iter().all(|call| call.2));
    assert_eq!(result["status"], "failed");
}

#[tokio::test]
async fn report_cap_failure_uses_failed_callback_and_never_changes_assertions() {
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = calls.clone();
    crate::supervisor_task::report_completion(
        json!({"actual":"x".repeat(crate::report::REPORT_LIMIT + 1)}),
        true,
        true,
        move |path, body, trusted| {
            observed.lock().unwrap().push((path, body, trusted));
            async { Ok(json!({})) }
        },
    )
    .await
    .unwrap();
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "/failed");
    assert!(
        calls[0].1["error"]
            .as_str()
            .unwrap()
            .contains("REPORT_LIMIT")
    );
}

#[tokio::test]
async fn successful_completion_and_failure_callback_errors_are_not_hidden() {
    let mut calls = 0;
    crate::supervisor_task::report_completion(json!({}), false, false, |path, _, trusted| {
        calls += 1;
        assert_eq!(path, "/complete");
        assert!(trusted);
        async { Ok(json!({})) }
    })
    .await
    .unwrap();
    assert_eq!(calls, 1);
    let error =
        crate::supervisor_task::report_completion(json!({}), false, false, |_, _, _| async {
            Err(yoneda_core::Error::new(
                "FENCED",
                "Synthetic terminal attempt",
            ))
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "FENCED");
}

#[tokio::test]
async fn supervisor_http_accepts_compact_metadata_but_rejects_megabyte_inline_diff() {
    use std::sync::{Arc, Mutex};
    let received = Arc::new(Mutex::new(Vec::new()));
    let observed = received.clone();
    let app = crate::supervisor::router("synthetic-token".into(), move |job| {
        observed.lock().unwrap().push(job);
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let url = format!("http://{address}/job");
    let mut job = json!({"id":"evaluate:candidate","kind":"evaluate","payload":{"candidate":{
        "id":"candidate","revision":{"repository":"test/fork","commit":"b".repeat(40)},"tree":"c".repeat(40)}}});
    job["payload"]["candidate"]["diff"] = json!("x".repeat(1024 * 1024 + 1));
    let response = client
        .post(&url)
        .bearer_auth("synthetic-token")
        .json(&job)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    assert!(received.lock().unwrap().is_empty());
    job["payload"]["candidate"]
        .as_object_mut()
        .unwrap()
        .remove("diff");
    job["payload"]["candidate"]["diff_digest"] = json!("d".repeat(64));
    let response = client.post(&url).json(&job).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
    assert!(received.lock().unwrap().is_empty());
    for _ in 0..2 {
        let response = client
            .post(&url)
            .bearer_auth("synthetic-token")
            .json(&job)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    }
    assert_eq!(*received.lock().unwrap(), vec![job]);
    server.abort();
}

#[cfg(target_os = "linux")]
#[test]
fn detached_pipe_fixture() {
    if std::env::var("YONEDA_DETACHED_PIPE_FIXTURE").as_deref() != Ok("1") {
        return;
    }
    // The background process leaves the process group but deliberately holds both pipes.
    unsafe {
        let pid = libc::fork();
        assert!(pid >= 0);
        if pid == 0 {
            libc::setsid();
            libc::sleep(30);
            libc::_exit(0);
        }
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn uid_barrier_stops_detached_pipe_holders_before_drain() {
    if unsafe { libc::geteuid() } != 0 {
        return;
    }
    let mut child = Command::new(std::env::current_exe().unwrap());
    crate::process::untrusted(&mut child, std::path::Path::new("/tmp"));
    child
        .args([
            "--exact",
            "tests::process_transport::detached_pipe_fixture",
            "--nocapture",
        ])
        .env("YONEDA_DETACHED_PIPE_FIXTURE", "1");
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        crate::process::bounded_output(&mut child),
    )
    .await
    .expect("The UID barrier must terminate a setsid descendant holding captured pipes")
    .unwrap();
    assert_eq!(output["exit"], 0);
}
