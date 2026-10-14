#![allow(dead_code)]
#[path = "../src/source_client.rs"]
mod source_client;
#[path = "../src/source_workspace.rs"]
mod source_workspace;
#[path = "../src/source_workspace_eval.rs"]
mod source_workspace_eval;
mod support;
use source_client::{SourceBackend, SourceCancellation, SourceChange};
use source_workspace::SourceWorkspace;
use source_workspace_eval::EvaluationSource;
use std::sync::Arc;
use support::MemorySource;
fn workspace(base: &Arc<MemorySource>) -> SourceWorkspace {
    SourceWorkspace::new(
        EvaluationSource::new(base.clone()).unwrap(),
        false,
        true,
        Arc::new(SourceCancellation::default()),
        1024,
    )
    .unwrap()
}
#[test]
fn eval_metadata_rename_and_chmod_reuse_unread_base_without_hydration() {
    let base = MemorySource::new();
    let fs = workspace(&base);
    let renamed = fs
        .apply(
            "move",
            &SourceChange::Rename {
                path: "app.js".into(),
                expected: 1,
                target: "renamed.js".into(),
                target_expected: None,
            },
        )
        .unwrap()
        .unwrap();
    fs.apply(
        "chmod",
        &SourceChange::Mode {
            path: "renamed.js".into(),
            expected: renamed.version,
            mode: 0o100755,
        },
    )
    .unwrap();
    assert_eq!(base.reads(), 0);
    assert_eq!(base.mutations(), 0);
    assert_eq!(fs.read("renamed.js", 0, 3).unwrap(), b"old");
    assert_eq!(base.reads(), 1);
}
#[test]
fn evaluation_writes_delete_truncate_are_ephemeral_not_server_changesets() {
    let base = MemorySource::new();
    let fs = workspace(&base);
    assert_eq!(base.reads(), 0);
    let after = fs
        .apply(
            "edit",
            &SourceChange::Write {
                path: "app.js".into(),
                expected: 1,
                offset: 1,
                bytes: b"X".to_vec(),
            },
        )
        .unwrap()
        .unwrap();
    let extended = fs
        .apply(
            "grow",
            &SourceChange::Truncate {
                path: "app.js".into(),
                expected: after.version,
                size: 5,
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(fs.read("app.js", 0, 5).unwrap(), b"oXd\0\0");
    fs.apply(
        "delete",
        &SourceChange::Delete {
            path: "app.js".into(),
            expected: extended.version,
        },
    )
    .unwrap();
    assert_eq!(fs.stat("app.js").unwrap_err().code, "SOURCE_NOT_FOUND");
    assert_eq!(base.mutations(), 0);
    assert_eq!(base.read("app.js", 1, 0, 3).unwrap().bytes, b"old");
    assert_eq!(workspace(&base).read("app.js", 0, 3).unwrap(), b"old");
}
#[test]
fn evaluation_scope_keeps_file_cas_and_directory_operations_fail_closed() {
    let base = MemorySource::new();
    let fs = workspace(&base);
    assert_eq!(
        fs.apply(
            "stale",
            &SourceChange::Delete {
                path: "app.js".into(),
                expected: 3
            }
        )
        .unwrap_err()
        .code,
        "FILE_VERSION_CONFLICT"
    );
    assert_eq!(
        fs.apply(
            "collision",
            &SourceChange::Rename {
                path: "app.js".into(),
                expected: 1,
                target: "other.js".into(),
                target_expected: None
            }
        )
        .unwrap_err()
        .code,
        "FILE_VERSION_CONFLICT"
    );
    assert_eq!(base.reads(), 0);
    assert_eq!(base.mutations(), 0);
}
