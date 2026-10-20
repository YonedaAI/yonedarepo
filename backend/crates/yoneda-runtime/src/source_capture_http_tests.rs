//! Native SQLite staged authority -> exact root HTTP -> a platform-commit stand-in over real Git;
//! no workerd/provider claim.
use crate::{
    source_capture_api::CaptureApi,
    source_capture_fixture::{TOKEN, fixture},
    source_capture_http_fixture::root,
    source_capture_runner::execute_with,
    source_git_fixture::{git, oid, server},
};
use serde_json::json;
use std::sync::atomic::Ordering;

fn job() -> serde_json::Value {
    json!({"kind":"capture","id":"capture","epoch":1,"source_capture_ref":{"branch":"agents/capture-test"},"payload":{"capture_subtype":"source_changeset","execution":{"strategy":"Native integration"}}})
}
#[tokio::test]
async fn sealed_http_capture_retains_overlay_closure_emits_actual_patch_and_commits_on_platform() {
    let (git_server, _, _) = server().await;
    let f = fixture(&git_server);
    let base = f.binding.base.commit.clone();
    let base_tree = f.binding.base.tree.clone();
    let root = root(f).await;
    let mut job = job();
    // Integrator captures must attest the frozen integration input manifest digest.
    job["payload"]["integration_digest"] = json!("integration-digest-fixture");
    let api = CaptureApi::new(&root.origin, TOKEN).unwrap();
    let source_origin = root.origin.clone();
    let workspace = root.fixture.binding.workspace_id.clone();
    let view = root.fixture.binding.view_digest.clone();
    let expected = root.fixture.bytes["wide/changed.bin"][65536..65545].to_vec();
    tokio::task::spawn_blocking(move || {
        use crate::{source_client::SourceBackend, source_client_api::ApiSourceClient};
        let client =
            ApiSourceClient::test_at(&source_origin, "repo", &workspace, &view, false).unwrap();
        assert_eq!(client.status().unwrap()["status"], "sealed");
        assert_eq!(client.list("wide/").unwrap().len(), 451);
        assert_eq!(
            client
                .read(
                    "wide/changed.bin",
                    client.stat("wide/changed.bin").unwrap().version,
                    65536,
                    9
                )
                .unwrap()
                .bytes,
            expected
        );
        assert_eq!(
            client
                .read("renamed", client.stat("renamed").unwrap().version, 0, 9)
                .unwrap()
                .bytes,
            b"untouched"
        );
        assert_eq!(
            client.operation("source_seal", json!({})).unwrap_err().code,
            "FORBIDDEN"
        );
    })
    .await
    .unwrap();
    let result = execute_with(&job, &api).await.unwrap();
    assert_eq!(result["id"], "candidate:capture:1");
    assert_eq!(result["integration_digest"], "integration-digest-fixture");
    assert_eq!(
        result["source_changeset_digest"],
        root.fixture.seal["changeset_digest"]
    );
    assert_eq!(result["parents"], json!([base]));
    assert!(result.get("source_lineage").is_none());
    assert_eq!(
        result["paths"],
        json!([
            "base",
            "delete",
            "mode",
            "renamed",
            "retained/overlay.bin",
            "wide/changed.bin"
        ])
    );
    let destination = &root.fixture.destination;
    let commit = result["commit"].as_str().unwrap();
    assert_eq!(
        oid(git(
            destination,
            &["rev-parse", &format!("{commit}^{{tree}}")],
            b""
        )),
        result["tree"]
    );
    assert_eq!(
        git(
            destination,
            &["show", &format!("{commit}:wide/untouched-0449")],
            b""
        ),
        b"unread\n"
    );
    assert_eq!(
        git(
            destination,
            &["show", &format!("{commit}:retained/overlay.bin")],
            b""
        ),
        b"specialist\0\xff"
    );
    let work = git_server.root.path().join("reference");
    git(&work, &["checkout", "--detach", &base], b"");
    std::fs::remove_file(work.join("base")).unwrap();
    std::fs::remove_file(work.join("delete")).unwrap();
    std::fs::write(work.join("renamed"), b"untouched").unwrap();
    std::fs::create_dir(work.join("retained")).unwrap();
    std::fs::write(work.join("retained/overlay.bin"), b"specialist\0\xff").unwrap();
    std::fs::write(
        work.join("wide/changed.bin"),
        &root.fixture.bytes["wide/changed.bin"],
    )
    .unwrap();
    git(&work, &["add", "."], b"");
    git(&work, &["update-index", "--chmod=+x", "mode"], b"");
    let reference_tree = oid(git(&work, &["write-tree"], b""));
    assert_eq!(reference_tree, result["tree"]);
    let reference_diff = String::from_utf8(git(
        &work,
        &[
            "diff",
            "--cached",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            &base,
        ],
        b"",
    ))
    .unwrap();
    assert_eq!(reference_diff, result["diff"].as_str().unwrap());
    assert_ne!(base_tree, result["tree"]);
    let requests = root.requests.lock().unwrap();
    // Only touched paths travel to the platform, with their final bytes.
    let sent: Vec<_> = requests
        .iter()
        .filter(|(op, _)| op == "commit")
        .flat_map(|(_, args)| {
            args["changes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["path"].clone())
        })
        .collect();
    assert_eq!(json!(sent), result["paths"]);
    assert!(
        requests
            .iter()
            .filter(|(op, _)| op == "blob")
            .all(|(_, args)| !args["path"].as_str().unwrap().contains("untouched"))
    );
    assert!(
        requests
            .iter()
            .any(|(op, args)| op == "tree" && args["path"] == "wide" && !args["cursor"].is_null()),
        "wide metadata actually paged"
    );
    assert!(
        requests.iter().any(|(op, args)| op == "tree"
            && args["input"] == "input-1"
            && args["path"] == "retained"),
        "foreign retained input ancestor hashes verified"
    );
    assert!(
        requests.iter().filter(|(op, _)| op == "manifest").count() > 4,
        "actual SQLite sealed deltas paged at one row"
    );
}
#[tokio::test]
async fn streamed_corruption_and_bad_ancestor_hash_fail_before_any_platform_commit() {
    for fault in [1, 2] {
        let (git_server, _, _) = server().await;
        let f = fixture(&git_server);
        let base = f.binding.base.commit.clone();
        let root = root(f).await;
        root.fault.store(fault, Ordering::SeqCst);
        let job = job();
        let api = CaptureApi::new(&root.origin, TOKEN).unwrap();
        assert!(execute_with(&job, &api).await.is_err());
        assert_eq!(
            oid(git(&root.fixture.destination, &["rev-parse", "main"], b"")),
            base
        );
        assert!(
            root.requests
                .lock()
                .unwrap()
                .iter()
                .all(|(op, _)| op != "commit")
        );
    }
}
#[tokio::test]
async fn independent_parent_readback_is_required_after_the_platform_commit() {
    let (git_server, _, _) = server().await;
    let f = fixture(&git_server);
    let base = f.binding.base.commit.clone();
    let root = root(f).await;
    root.fault.store(3, Ordering::SeqCst);
    let job = job();
    let api = CaptureApi::new(&root.origin, TOKEN).unwrap();
    assert!(execute_with(&job, &api).await.is_err());
    assert_ne!(
        oid(git(&root.fixture.destination, &["rev-parse", "main"], b"")),
        base,
        "a recorded commit alone is never successful capture authority"
    );
}
