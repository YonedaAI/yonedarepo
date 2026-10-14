use super::{approved_parents, protected_delta};
use crate::transport::{GitFile, GitWorkspace};
use serde_json::json;
use yoneda_core::{Policy, build::checks_from_report};

#[test]
fn rewriting_or_deleting_the_runner_fails_even_when_candidate_exits_zero() {
    let original = GitWorkspace::from([(
        "tests/run.sh".into(),
        GitFile {
            bytes: b"#!/bin/sh\nrun-tests\n".to_vec(),
            executable: true,
        },
    )]);
    for changed in [
        GitWorkspace::from([(
            "tests/run.sh".into(),
            GitFile {
                bytes: b"#!/bin/sh\nexit 0\n".to_vec(),
                executable: true,
            },
        )]),
        GitWorkspace::new(),
    ] {
        let protected = protected_delta(&original, &changed, ["tests/run.sh"].into_iter());
        let policy: Policy = serde_json::from_value(json!({
                "version":"owner-v1","suite":"commands-v1","environment":yoneda_core::build::ENVIRONMENT,
                "required_checks":["owner-tests"],"build":{"checks":[{"name":"owner-tests","argv":["sh","/opt/yoneda/test-bundle/tests/run.sh"],"timeout_seconds":10}],
                "test_bundle":{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protected_paths":["tests/run.sh"]}}
            })).unwrap();
        let report = json!({"test_bundle_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "protected_changes":protected,"commands":[{"name":"owner-tests","output":{"exit":0}}],"setup":[]});
        assert_eq!(
            checks_from_report(&policy, &report).unwrap()[0].status,
            "fail"
        );
    }
}

#[test]
fn only_refreshed_candidates_may_use_two_frozen_parents() {
    let head = "a".repeat(40);
    let source = "b".repeat(40);
    let ordinary = json!({"payload":{"candidate":{"base":{"commit":head}}}});
    assert_eq!(
        approved_parents(&ordinary, &head).unwrap(),
        vec![head.as_str()]
    );
    let refreshed = json!({"payload":{"candidate":{"base":{"commit":head},
            "refresh_of":"candidate:old","approved_parents":[head,source]}}});
    assert_eq!(
        approved_parents(&refreshed, &head).unwrap(),
        vec![head.as_str(), source.as_str()]
    );
    let missing =
        json!({"payload":{"candidate":{"base":{"commit":head},"refresh_of":"candidate:old"}}});
    assert!(approved_parents(&missing, &head).is_err());
    let forged = json!({"payload":{"candidate":{"base":{"commit":head},
            "approved_parents":[head,source]}}});
    assert!(approved_parents(&forged, &head).is_err());
}
