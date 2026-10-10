use super::*;
use std::time::Duration;
use tokio::process::Command;

#[tokio::test]
async fn agent_deadline_retains_tool_feedback_that_was_emitted_before_cancellation() {
    let transcript = Transcript::default();
    let mut child = Command::new("/bin/sh");
    crate::process::untrusted(&mut child, std::path::Path::new("/tmp"));
    child.args(["-c", "printf 'tool_call:team_plan_propose\\n'; printf 'pid:%s\\n' \"$$\"; printf 'INVALID_INPUT: task scopes overlap\\n' >&2; exec sleep 30"]);
    let result = tokio::time::timeout(
        Duration::from_millis(300),
        crate::process::captured_output(&mut child, &transcript),
    )
    .await;
    assert!(result.is_err(), "fixture must exceed its deadline");
    let partial = transcript.partial_timeout().unwrap();
    assert!(
        partial["stdout"]
            .as_str()
            .unwrap()
            .contains("tool_call:team_plan_propose")
    );
    assert!(
        partial["stderr"]
            .as_str()
            .unwrap()
            .contains("INVALID_INPUT: task scopes overlap")
    );
    assert_eq!(partial["partial"], true);
    assert_eq!(partial["timeout"], true);
    assert_eq!(partial["error_code"], "EXECUTION_TIMEOUT");
    assert!(partial["exit"].is_null());
    #[cfg(unix)]
    {
        let pid: i32 = partial["stdout"]
            .as_str()
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix("pid:"))
            .unwrap()
            .parse()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("timed-out child must be killed and reaped");
    }
    let calls = Arc::new(Mutex::new(Vec::new()));
    let captured = calls.clone();
    crate::supervisor_task::report_deadline(Some(&transcript), move |path, body, trusted| {
        captured.lock().unwrap().push((path, body, trusted));
        async { Ok(json!({"digest":"a".repeat(64)})) }
    })
    .await
    .unwrap();
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, "/evidence");
    let evidence: Value = serde_json::from_str(calls[0].1["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        evidence, partial,
        "retain the actual pre-deadline tool and validation output"
    );
    assert_eq!(calls[1].0, "/failed");
    assert_eq!(
        calls[1].1["error"],
        "EXECUTION_TIMEOUT: Execution deadline exceeded"
    );
    assert!(
        calls.iter().all(|call| call.2),
        "both callbacks require supervisor authority"
    );
    assert!(transcript.is_recorded().unwrap());
}

#[test]
fn agent_transcript_caps_each_stream_and_bounds_escaped_partial_evidence() {
    let transcript = Transcript::default();
    for channel in [Channel::Stdout, Channel::Stderr] {
        transcript
            .append(channel, &vec![0; STREAM_LIMIT + 8192])
            .unwrap();
    }
    let normal = transcript.output(Some(0), None).unwrap();
    for field in ["stdout", "stderr"] {
        assert!(normal[field].as_str().unwrap().len() <= STREAM_LIMIT);
    }
    assert_eq!(normal["stdout_truncated"], true);
    assert_eq!(normal["stderr_truncated"], true);
    let partial = transcript.partial_timeout().unwrap();
    assert!(partial.to_string().len() <= 8 * 1024 * 1024);
    assert_eq!(partial["partial"], true);
}

#[tokio::test]
async fn agent_deadline_preserves_acknowledged_evidence_and_still_reports_rejected_uploads() {
    let transcript = Transcript::default();
    transcript
        .append(Channel::Stdout, b"owner-only output")
        .unwrap();
    transcript.mark_recorded().unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let captured = calls.clone();
    crate::supervisor_task::report_deadline(Some(&transcript), move |path, _, trusted| {
        captured.lock().unwrap().push((path, trusted));
        async { Ok(json!({})) }
    })
    .await
    .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![("/failed", true)],
        "an acknowledged immutable pointer is not replaced"
    );
    let transcript = Transcript::default();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let captured = calls.clone();
    crate::supervisor_task::report_deadline(Some(&transcript), move |path, _, trusted| {
        captured.lock().unwrap().push((path, trusted));
        async move {
            if path == "/evidence" {
                Err(yoneda_core::Error::new("FENCED", "Simulated stale attempt"))
            } else {
                Ok(json!({}))
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![("/evidence", true), ("/failed", true)]
    );
    assert!(
        !transcript.is_recorded().unwrap(),
        "rejected evidence must never be acknowledged locally"
    );
}

#[tokio::test]
async fn agent_deadline_stops_a_stalled_evidence_upload_before_failure_reporting() {
    let transcript = Transcript::default();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let captured = calls.clone();
    tokio::time::timeout(
        Duration::from_secs(3),
        crate::supervisor_task::report_deadline(Some(&transcript), move |path, _, trusted| {
            captured.lock().unwrap().push((path, trusted));
            async move {
                if path == "/evidence" {
                    std::future::pending::<()>().await;
                }
                Ok(json!({}))
            }
        }),
    )
    .await
    .expect("two-second evidence cap must leave time for failure reporting")
    .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![("/evidence", true), ("/failed", true)]
    );
    assert!(!transcript.is_recorded().unwrap());
}

#[test]
fn normal_report_caps_json_expansion_and_keeps_exit_observations() {
    let transcript = Transcript::default();
    for channel in [Channel::Stdout, Channel::Stderr] {
        transcript
            .append(channel, &vec![0; STREAM_LIMIT + 1])
            .unwrap();
    }
    let output = transcript.output(Some(7), None).unwrap();
    assert!(
        output.to_string().len() <= 8 * 1024 * 1024,
        "Normal escaped transcript exceeds R2 report cap"
    );
    assert_eq!(output["exit"], 7);
    assert_eq!(output["stdout_truncated"], true);
    assert_eq!(output["stderr_truncated"], true);
}
