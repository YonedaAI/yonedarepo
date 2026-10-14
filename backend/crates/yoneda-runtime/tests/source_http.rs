#![allow(dead_code)] // These modules are independently compiled before parent shared registration.
#[path = "support/http.rs"]
mod http;
#[path = "../src/source_client.rs"]
mod source_client;
#[path = "../src/source_client_api.rs"]
mod source_client_api;
use http::{Response, Server, file, read_meta, status};
use serde_json::json;
use source_client::{SourceBackend, SourceChange};
use source_client_api::ApiSourceClient;

#[test]
fn source_identity_and_readonly_are_fenced_before_content_or_write() {
    let mut wrong = status();
    wrong["workspace_id"] = json!("other");
    let server = Server::new(vec![Response::json(wrong)]);
    assert!(
        matches!(ApiSourceClient::test_at(&server.origin,"repo","ws","view",false),Err(error) if error.code=="SOURCE_FENCED")
    );
    assert_eq!(server.count(), 1);
    let mut ro = status();
    ro["access"] = json!("read_only");
    let server = Server::new(vec![Response::json(ro)]);
    let client =
        ApiSourceClient::test_at(&server.origin, "candidate-0", "ws", "view", true).unwrap();
    assert_eq!(
        client
            .apply(
                "no",
                &SourceChange::Delete {
                    path: "app.js".into(),
                    expected: 0
                }
            )
            .unwrap_err()
            .code,
        "SOURCE_READ_ONLY"
    );
    for op in [
        "source_seal",
        "source_verify_upload",
        "source_init",
        "source_gc_claim",
    ] {
        assert_eq!(
            client.operation(op, json!({})).unwrap_err().code,
            "FORBIDDEN"
        );
    }
    assert_eq!(server.count(), 1);
    assert!(server.requests.lock().unwrap()[0].starts_with("POST /v1/candidate-0/source_status "));
}
#[test]
fn source_read_checks_exact_range_version_and_requires_raw_content_type() {
    let mut wrong = read_meta();
    wrong["file"]["file_version"] = json!(1);
    let mut wrong_type = Response::raw(read_meta(), b"old");
    wrong_type.headers[0].1 = "text/html".into();
    let server = Server::new(vec![
        Response::json(status()),
        Response::raw(wrong, b"old"),
        wrong_type,
        Response::raw(read_meta(), b"old"),
    ]);
    let client = ApiSourceClient::test_at(&server.origin, "repo", "ws", "view", false).unwrap();
    assert_eq!(
        client.read("app.js", 0, 0, 3).unwrap_err().code,
        "SOURCE_FENCED"
    );
    assert_eq!(
        client.read("app.js", 0, 0, 3).unwrap_err().code,
        "SOURCE_FENCED"
    );
    assert_eq!(client.read("app.js", 0, 0, 3).unwrap().bytes, b"old");
}
#[test]
fn mutation_ack_requires_file_receipt_not_only_global_version() {
    let receipt = json!({"version":1,"workspace_id":"ws","workspace_version":1,"request_id":"mode","authority":"staged_source","file_versions":{"wrong.js":1}});
    let server = Server::new(vec![
        Response::json(status()),
        Response::json(status()),
        Response::json(file(0)),
        Response::json(receipt),
        Response::json(file(1)),
    ]);
    let client = ApiSourceClient::test_at(&server.origin, "repo", "ws", "view", false).unwrap();
    assert_eq!(
        client
            .apply(
                "mode",
                &SourceChange::Mode {
                    path: "app.js".into(),
                    expected: 0,
                    mode: 0o100755
                }
            )
            .unwrap_err()
            .code,
        "SOURCE_FENCED"
    );
}
#[test]
fn supervisor_bearer_only_on_seal_and_normal_requests_have_no_credentials() {
    let checkpoint = json!({"checkpoint_id":"checkpoint","changeset_digest":"digest"});
    let server = Server::new(vec![
        Response::json(status()),
        Response::json(status()),
        Response::json(checkpoint),
        Response::json(json!({"seal_id":"seal"})),
    ]);
    let client = ApiSourceClient::test_at(&server.origin, "repo", "ws", "view", false).unwrap();
    assert_eq!(
        client.seal("final", "test-supervisor-only").unwrap()["seal_id"],
        "seal"
    );
    let requests = server.requests.lock().unwrap();
    assert!(
        requests[..3]
            .iter()
            .all(|request| !request.to_ascii_lowercase().contains("authorization:"))
    );
    assert!(requests[3].contains("authorization: Bearer test-supervisor-only"));
    assert!(
        requests
            .iter()
            .all(|request| !request.to_ascii_lowercase().contains("cookie:"))
    );
}
#[test]
fn write_uploads_only_touched_file_and_ack_survives_unrelated_version_change() {
    let ticket = json!({"version":1,"workspace_id":"ws","workspace_version":0,"ticket":{"id":"ticket","path":"app.js","sha256":yoneda_core::digest(b"oXd"),"size":3,"mode":"100644","state":"verified"},"authority":"staged_source"});
    let receipt = json!({"version":1,"workspace_id":"ws","workspace_version":1,"request_id":"write","authority":"staged_source","file_versions":{"app.js":1}});
    let server = Server::new(vec![
        Response::json(status()),
        Response::json(status()),
        Response::json(file(0)),
        Response::raw(read_meta(), b"old"),
        Response::json(ticket),
        Response::json(receipt),
        Response::json(file(1)),
    ]);
    let client = ApiSourceClient::test_at(&server.origin, "repo", "ws", "view", false).unwrap();
    assert_eq!(
        client
            .apply(
                "write",
                &SourceChange::Write {
                    path: "app.js".into(),
                    expected: 0,
                    offset: 1,
                    bytes: b"X".to_vec()
                }
            )
            .unwrap()
            .unwrap()
            .version,
        1
    );
    let observed = server.requests.lock().unwrap();
    assert_eq!(
        observed
            .iter()
            .filter(|request| request.starts_with("POST /v1/repo/source_read "))
            .count(),
        1
    );
    assert!(observed[4].starts_with("PUT /v1/repo/blob?"));
    assert!(observed[4].contains("request_id=write-upload"));
    assert!(observed[4].ends_with("oXd"));
    assert!(
        !observed
            .last()
            .unwrap()
            .contains("expected_workspace_version")
    );
}
#[test]
fn verified_upload_response_must_match_bytes_path_mode_and_identity() {
    let ticket = json!({"version":1,"workspace_id":"ws","workspace_version":0,"ticket":{"id":"ticket","path":"wrong.js","sha256":yoneda_core::digest(b"old"),"size":3,"mode":"100644","state":"verified"},"authority":"staged_source"});
    let receipt = json!({"version":1,"workspace_id":"ws","workspace_version":1,"request_id":"write","authority":"staged_source","file_versions":{"app.js":1}});
    let server = Server::new(vec![
        Response::json(status()),
        Response::json(status()),
        Response::json(file(0)),
        Response::raw(read_meta(), b"old"),
        Response::json(ticket),
        Response::json(receipt),
        Response::json(file(1)),
    ]);
    let client = ApiSourceClient::test_at(&server.origin, "repo", "ws", "view", false).unwrap();
    assert_eq!(
        client
            .apply(
                "write",
                &SourceChange::Write {
                    path: "app.js".into(),
                    expected: 0,
                    offset: 1,
                    bytes: b"X".to_vec()
                }
            )
            .unwrap_err()
            .code,
        "SOURCE_FENCED"
    );
    assert_eq!(server.count(), 5);
}
#[test]
fn bounded_mcp_upload_computes_hash_and_preserves_binary_without_authority_headers() {
    use base64::Engine;
    let bytes = [0u8, 255, 10];
    let server = Server::new(vec![
        Response::json(status()),
        Response::json(json!({"ticket":{"id":"verified"}})),
    ]);
    let client = ApiSourceClient::test_at(&server.origin, "repo", "ws", "view", false).unwrap();
    let args = json!({"request_id":"mcp:upload:1","path":"app.js","mode":"100644","content_base64":base64::engine::general_purpose::STANDARD.encode(bytes),"expected_workspace_version":0,"expected_file_version":0});
    assert_eq!(
        client.tool("source_upload", args.clone()).unwrap()["ticket"]["id"],
        "verified"
    );
    let observed = server.requests.lock().unwrap();
    assert!(observed[1].starts_with("PUT /v1/repo/blob?"));
    assert!(observed[1].contains(&format!("sha256={}", yoneda_core::digest(&bytes))));
    assert!(observed[1].contains("request_id=mcp%3Aupload%3A1"));
    assert!(!observed[1].contains("authorization:"));
    assert!(!observed[1].contains("x-yoneda-source-fuse:"));
    drop(observed);
    let mut over = args.clone();
    over["content_base64"] = json!("A".repeat(90000));
    assert_eq!(
        client.tool("source_upload", over).unwrap_err().code,
        "SOURCE_LIMIT"
    );
    let mut forged = args;
    forged["sha256"] = json!("a".repeat(64));
    assert_eq!(
        client.tool("source_upload", forged).unwrap_err().code,
        "INVALID_SOURCE"
    );
    assert_eq!(server.count(), 2);
}
#[test]
fn root_fuse_transport_marks_authenticated_requests_and_model_bridge_cannot_inherit_it() {
    let server = Server::new(vec![Response::json(status()), Response::json(status())]);
    let root = ApiSourceClient::test_root_at(
        &server.origin,
        "repo",
        "ws",
        "view",
        false,
        "root-only-fixture",
    )
    .unwrap();
    root.status().unwrap();
    assert!(server.requests.lock().unwrap().iter().all(|request| {
        request.contains("authorization: Bearer root-only-fixture")
            && request.contains("x-yoneda-source-fuse: 1")
    }));
    assert_eq!(
        root.operation("source_seal", json!({})).unwrap_err().code,
        "FORBIDDEN"
    );
}
