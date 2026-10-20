use super::*;
#[tokio::test]
async fn malformed_guided_binding_fails_before_mount_or_untrusted_checks() {
    let root = tempfile::tempdir().unwrap();
    let job = json!({"id":"bad-guide","kind":"evaluate","payload":{"workspace_transport":"api-source-v1","guided":{"session_id":"guide-session:test","profile_id":"task-board-v1","version":1,"step_id":"concurrent","check_phase":"final","variant":"filter"}}});
    let error = execute(&job, root.path()).await.unwrap_err();
    assert_eq!(error.code, "GUIDED_BINDING");
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}
#[tokio::test]
async fn dirty_api_protected_oracle_runs_zero_candidate_commands_or_bundle_downloads() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("must-not-run");
    let profile = yoneda_agents_core::build::BuildProfile {
        app: None,
        setup: vec![],
        checks: vec![yoneda_agents_core::build::CommandSpec {
            name: "protected".into(),
            argv: vec![
                "/bin/sh".into(),
                "-c".into(),
                format!(
                    "touch {}; # /opt/yoneda/test-bundle/run.mjs",
                    marker.display()
                ),
            ],
            timeout_seconds: 30,
        }],
        static_dir: None,
        test_bundle: Some(yoneda_agents_core::build::TestBundlePolicy {
            digest: "a".repeat(64),
            protected_paths: vec!["tests".into()],
        }),
    };
    let policy = yoneda_agents_core::Policy {
        suite: "commands-v1".into(),
        environment: yoneda_agents_core::build::ENVIRONMENT.into(),
        required_checks: vec!["protected".into()],
        build: Some(profile),
        ..yoneda_agents_core::Policy::default()
    };
    let policy_json = serde_json::to_value(&policy).unwrap();
    let revision = json!({"repository":"repo","commit":"1".repeat(40)});
    let job = json!({"payload":{"workspace_transport":"api-source-v1","policy":policy_json,"candidate":{"id":"candidate","revision":revision,"paths_ref":{"version":1,"id":"paths","count":10000,"digest":"d".repeat(64)}},"source_integrity":{"version":1,"candidate_id":"candidate","revision":revision,"paths_digest":"d".repeat(64),"protected_changes":["tests"],"policy_digest":yoneda_agents_core::fingerprint(&policy_json).unwrap()}}});
    let report = run_evaluation(&job, root.path()).await.unwrap();
    assert_eq!(report["commands"], json!([]));
    assert_eq!(report["protected_changes"], json!(["tests"]));
    assert!(!marker.exists());
    assert_eq!(
        yoneda_agents_core::build::checks_from_report(&policy, &report).unwrap()[0].status,
        "fail"
    );
}
