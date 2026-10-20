//! Production sparse refresh clients/runner against native Git HTTP and a frozen root adapter.
use crate::{
    source_git_http::SourceGitHttp,
    source_git_http_tests::{git, oid},
    source_refresh_api::Api,
    source_refresh_http_fixture::{Fixture, TOKEN, fixture},
    source_refresh_runner::execute_with,
    source_refresh_upload::Upload,
};
use std::sync::atomic::Ordering;
async fn run(f: &Fixture) -> yoneda_agents_core::Result<serde_json::Value> {
    let api = Api::new(&f.origin, TOKEN)?;
    let target = SourceGitHttp::new(&f.git.url, None).unwrap();
    let source = Upload::new(&f.git.url.replace("fork.git", "candidate.git"), None)?;
    execute_with(&f.job(), &api, &target, &source).await
}
fn assert_sparse(f: &Fixture, result: &serde_json::Value) {
    let target = f.git.root.path().join("fork.git");
    let commit = result["transport_receipt"]["commit"].as_str().unwrap();
    assert_eq!(
        oid(git(&target, &["rev-parse", &format!("{commit}^1")], b"")),
        f.head
    );
    assert_eq!(
        oid(git(&target, &["rev-parse", &format!("{commit}^2")], b"")),
        f.candidate
    );
    assert_eq!(
        git(
            &target,
            &["show", &format!("{commit}:wide/unread-0449")],
            b""
        ),
        b"unread source\n"
    );
    let native = String::from_utf8(git(
        &target,
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            &f.head,
            commit,
        ],
        b"",
    ))
    .unwrap();
    assert_eq!(native, result["diff"].as_str().unwrap());
    assert!(
        f.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(op, _)| op == "blob")
            .all(
                |(_, args)| !args["path"].as_str().unwrap().contains("unread")
                    && args["path"] != "head-only"
            )
    );
    assert!(
        f.calls
            .lock()
            .unwrap()
            .iter()
            .any(|(op, args)| op == "tree" && args["path"] == "wide" && !args["cursor"].is_null())
    );
}
#[tokio::test]
async fn sparse_root_refresh_matches_native_disjoint_and_text_merge_without_unread_bodies() {
    let f = fixture(false).await;
    f.git.lose_ack.store(true, Ordering::SeqCst);
    let result = run(&f).await.unwrap();
    assert_eq!(result["status"], "clean");
    assert_eq!(
        result["paths"],
        serde_json::json!(["candidate-only", "text"])
    );
    let tree = oid(git(
        &f.work,
        &["merge-tree", "--write-tree", &f.head, &f.candidate],
        b"",
    ));
    assert_eq!(result["tree"], tree);
    assert_sparse(&f, &result);
    assert_eq!(result["incremental_refresh"]["input_ack_recovered"], true);
    let again = run(&f).await.unwrap();
    assert_eq!(again["merge_commit"], result["merge_commit"]);
    assert_eq!(again["incremental_refresh"]["input_pack_uploaded"], false);
    assert_eq!(again["incremental_refresh"]["merge_pack_uploaded"], false);
}
#[tokio::test]
async fn binary_and_structural_conflicts_preserve_head_and_merge_disjoint_text() {
    let f = fixture(true).await;
    let result = run(&f).await.unwrap();
    assert_eq!(result["status"], "unresolved");
    assert!(result["merge_commit"].is_null());
    assert!(result["revision"].is_null());
    assert_eq!(
        result["conflict_paths"],
        serde_json::json!(["binary", "shape", "shape/file"])
    );
    assert_sparse(&f, &result);
    let target = f.git.root.path().join("fork.git");
    let commit = result["merge_workspace_commit"].as_str().unwrap();
    assert_eq!(
        git(&target, &["show", &format!("{commit}:binary")], b""),
        b"head\0"
    );
    assert_eq!(
        git(&target, &["show", &format!("{commit}:shape/file")], b""),
        b"head shape\n"
    );
    git(&f.work, &["checkout", "--detach", &f.head], b"");
    std::fs::write(f.work.join("candidate-only"), b"candidate kept\n").unwrap();
    std::fs::write(
        f.work.join("text"),
        b"HEAD\ntwo\nthree\nfour\nfive\nsix\nCANDIDATE\n",
    )
    .unwrap();
    git(&f.work, &["add", "."], b"");
    assert_eq!(oid(git(&f.work, &["write-tree"], b"")), result["tree"]);
}
#[tokio::test]
async fn pinned_scope_mutation_and_input_readback_mismatch_never_update_head() {
    for fault in [1, 2] {
        let f = fixture(false).await;
        f.fault.store(fault, Ordering::SeqCst);
        assert!(run(&f).await.is_err());
        assert_eq!(
            oid(git(
                &f.git.root.path().join("fork.git"),
                &["rev-parse", "main"],
                b""
            )),
            f.head
        );
        if fault == 1 {
            assert!(!f.calls.lock().unwrap().iter().any(|(op, _)| op == "blob"));
            assert!(!f.git.root.path().join("received.request").exists());
        }
    }
}
