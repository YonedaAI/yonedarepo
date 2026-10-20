//! Full Linux runtime health and API launch boundary; no providers or source network fixture.
use serde_json::json;

#[test]
#[ignore = "Requires actual root Linux container; targeted integration gate"]
fn actual_linux_runtime_health_proof_and_missing_source_index_guard_before_inference() {
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "Actual root Linux runtime required"
    );
    let health = crate::supervisor::health();
    assert_eq!(health["child_privileges"]["verified"], true);
    assert_eq!(health["child_privileges"]["uid"], 1000);
    assert_eq!(health["child_privileges"]["gid"], 1000);
    for mask in ["effective", "permitted", "inheritable", "ambient"] {
        assert_eq!(health["child_privileges"][mask], "0");
    }
    assert_eq!(health["child_privileges"]["no_new_privs"], 1);
    for capability in [
        "source_api",
        "lazy_source",
        "source_capture",
        "child_privilege_drop",
    ] {
        assert_eq!(health["capabilities"][capability], 1);
    }
    let root = tempfile::tempdir().unwrap();
    let pending = json!({"id":"missing-index","epoch":1,"kind":"agent",
        "payload":{"workspace_transport":"api-source-v1"}});
    let result = crate::source_workspace_run::SourceRun::prepare(&pending, root.path(), false);
    match result {
        Ok(_) => panic!("Missing source metadata must not prepare a paid agent"),
        Err(error) => assert_eq!(error.code, "SOURCE_INDEX_PENDING"),
    }
    assert!(!crate::source_workspace_registry::active());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    // Both builders failed: the frozen review is still a legitimate read-only attempt,
    // but cannot invent source mounts or request source blobs/seals.
    let manifest = json!({"version":1,"alternatives":[
        {"candidate_id":null,"status":"failed"},{"candidate_id":null,"status":"failed"}
    ]});
    let review = json!({"id":"empty-review","epoch":1,"kind":"agent","source_mounts":[],
        "payload":{"workspace_transport":"api-source-v1","comparison_review":true,"review_only":true,
        "execution":{"comparison_role":"reviewer","comparison_approval_id":"approval"},
        "run":{"comparison":{"approval":{"id":"approval"}}},
        "comparison_manifest":{"version":1,"approval_id":"approval","manifest":manifest,
        "manifest_digest":yoneda_agents_core::fingerprint(&manifest).unwrap()}}});
    let attempt =
        crate::source_workspace_run::SourceRun::prepare(&review, root.path(), false).unwrap();
    assert_eq!(attempt.root(), root.path());
    assert!(crate::source_workspace_registry::active());
    assert!(
        crate::source_workspace_registry::invalidate(
            crate::source_workspace_registry::SourceInvalidation {
                alias: "candidate-0".into(),
                paths: vec!["app.js".into()],
                job_id: "empty-review".into(),
                epoch: 1,
            }
        )
        .is_err()
    );
    drop(attempt); // Actual isolated runtime reaps before unregister/unmount.
    assert!(!crate::source_workspace_registry::active());
    let session =
        crate::source_workspace_session::SourceSession::prepare(&review, root.path()).unwrap();
    assert_eq!(session.working_directory(), root.path());
    let receipt = session
        .finish("empty-review-complete", "root-fixture")
        .unwrap();
    assert_eq!(
        receipt,
        json!({"transport":"api-source-v1","mounts":{},"checked":false,"published":false})
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}
