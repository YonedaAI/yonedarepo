#![allow(dead_code)] // Path modules compile focused mechanics independently of shared runtime registration.
#[path = "../src/source_client.rs"]
mod source_client;
#[path = "../src/source_workspace.rs"]
mod source_workspace;
mod support;

use source_client::{SourceCancellation, SourceChange};
use source_workspace::SourceWorkspace;
use std::sync::Arc;
use support::MemorySource;

fn mount(source: &Arc<MemorySource>, read_only: bool, cache: usize) -> SourceWorkspace {
    SourceWorkspace::new(
        source.clone(),
        read_only,
        true,
        Arc::new(SourceCancellation::default()),
        cache,
    )
    .unwrap()
}

#[test]
fn readonly_mount_denies_before_any_server_mutation_independently_of_os_uid() {
    let source = MemorySource::new();
    let fs = mount(&source, true, 1024);
    let error = fs
        .apply(
            "readonly-write",
            &SourceChange::Write {
                path: "app.js".into(),
                expected: 1,
                offset: 0,
                bytes: b"unsafe".to_vec(),
            },
        )
        .unwrap_err();
    assert_eq!(error.code, "SOURCE_READ_ONLY");
    assert_eq!(source.mutations(), 0);
    assert_eq!(fs.read("app.js", 0, 3).unwrap(), b"old");
}

#[test]
fn stale_or_misaligned_read_response_is_never_returned_or_cached() {
    let source = MemorySource::new();
    let fs = mount(&source, false, 1024);
    source.bad_slice(true);
    assert_eq!(fs.read("app.js", 0, 3).unwrap_err().code, "SOURCE_FENCED");
    source.bad_slice(false);
    assert_eq!(fs.read("app.js", 0, 3).unwrap(), b"old");
    assert_eq!(source.reads(), 2);
}

#[test]
fn metadata_reads_never_hydrate_and_versioned_cache_observes_api_changes() {
    let source = MemorySource::new();
    let fs = mount(&source, false, 1024);
    assert_eq!(fs.list("").unwrap().len(), 2);
    fs.stat("app.js").unwrap();
    assert_eq!(source.reads(), 0);
    assert_eq!(fs.read("app.js", 0, 3).unwrap(), b"old");
    assert_eq!(fs.read("app.js", 0, 3).unwrap(), b"old");
    assert_eq!(source.reads(), 1);
    source.external_write("app.js", b"new");
    assert_eq!(fs.read("app.js", 0, 3).unwrap(), b"new");
    assert_eq!(source.reads(), 2);
    let reopened = mount(&source, false, 1024);
    assert_eq!(reopened.read("app.js", 0, 3).unwrap(), b"new");
}

#[test]
fn writes_are_server_cas_and_acknowledgment_loss_never_creates_a_second_request() {
    let source = MemorySource::new();
    let fs = mount(&source, false, 1024);
    source.external_write("app.js", b"api");
    let stale = SourceChange::Write {
        path: "app.js".into(),
        expected: 1,
        offset: 0,
        bytes: b"cli".to_vec(),
    };
    assert_eq!(fs.apply("stale", &stale).unwrap_err().code, "SOURCE_CAS");
    assert_eq!(fs.read("app.js", 0, 3).unwrap(), b"api");
    source.lose_ack(true);
    let change = SourceChange::Write {
        path: "app.js".into(),
        expected: 2,
        offset: 0,
        bytes: b"cli".to_vec(),
    };
    assert_eq!(
        fs.apply("stable-id", &change).unwrap_err().code,
        "SOURCE_UNCERTAIN"
    );
    assert_eq!(source.mutations(), 2);
    assert_eq!(fs.read("app.js", 0, 3).unwrap(), b"cli");
}

#[test]
fn cache_bound_evicts_and_index_readiness_precedes_any_source_access() {
    let source = MemorySource::new();
    let missing = SourceWorkspace::new(
        source.clone(),
        false,
        false,
        Arc::new(SourceCancellation::default()),
        3,
    );
    assert!(matches!(missing, Err(error) if error.code == "SOURCE_INDEX_PENDING"));
    assert_eq!(source.stats(), 0);
    let fs = mount(&source, false, 3);
    fs.read("app.js", 0, 3).unwrap();
    fs.read("other.js", 0, 3).unwrap();
    fs.read("app.js", 0, 3).unwrap();
    assert_eq!(source.reads(), 3);
}

#[test]
fn cancellation_fences_read_write_and_restart_uses_only_committed_server_state() {
    let source = MemorySource::new();
    let fs = mount(&source, false, 1024);
    assert!(!fs.read_only());
    fs.read("app.js", 0, 3).unwrap();
    fs.cancel().unwrap();
    assert_eq!(
        fs.read("app.js", 0, 3).unwrap_err().code,
        "SOURCE_CANCELLED"
    );
    assert_eq!(
        fs.apply(
            "cancelled",
            &SourceChange::Delete {
                path: "app.js".into(),
                expected: 1
            }
        )
        .unwrap_err()
        .code,
        "SOURCE_CANCELLED"
    );
    assert_eq!(source.mutations(), 0);
    assert_eq!(
        mount(&source, false, 1024).read("app.js", 0, 3).unwrap(),
        b"old"
    );
}

#[test]
fn create_replace_truncate_rename_delete_and_executable_mode_preserve_server_versions() {
    let source = MemorySource::new();
    let fs = mount(&source, false, 1024);
    let temp = fs
        .apply(
            "create",
            &SourceChange::Create {
                path: "save.tmp".into(),
                mode: 0o100644,
            },
        )
        .unwrap()
        .unwrap();
    let written = fs
        .apply(
            "write",
            &SourceChange::Write {
                path: "save.tmp".into(),
                expected: temp.version,
                offset: 0,
                bytes: b"replacement".to_vec(),
            },
        )
        .unwrap()
        .unwrap();
    let renamed = fs
        .apply(
            "rename",
            &SourceChange::Rename {
                path: "save.tmp".into(),
                expected: written.version,
                target: "app.js".into(),
                target_expected: Some(1),
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(fs.read("app.js", 0, 11).unwrap(), b"replacement");
    assert_eq!(fs.stat("save.tmp").unwrap_err().code, "SOURCE_NOT_FOUND");
    let mode = fs
        .apply(
            "mode",
            &SourceChange::Mode {
                path: "app.js".into(),
                expected: renamed.version,
                mode: 0o100755,
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(mode.mode, 0o100755);
    let truncated = fs
        .apply(
            "truncate",
            &SourceChange::Truncate {
                path: "app.js".into(),
                expected: mode.version,
                size: 3,
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(fs.read("app.js", 0, 10).unwrap(), b"rep");
    fs.apply(
        "delete",
        &SourceChange::Delete {
            path: "app.js".into(),
            expected: truncated.version,
        },
    )
    .unwrap();
    assert_eq!(fs.stat("app.js").unwrap_err().code, "SOURCE_NOT_FOUND");
}
#[test]
fn bounded_cache_keeps_multiple_pages_of_same_immutable_file_version() {
    let source = MemorySource::new();
    let fs = mount(&source, false, 1024);
    assert_eq!(fs.read("app.js", 0, 1).unwrap(), b"o");
    assert_eq!(fs.read("app.js", 1, 1).unwrap(), b"l");
    assert_eq!(fs.read("app.js", 0, 1).unwrap(), b"o");
    assert_eq!(source.reads(), 2);
}
#[test]
fn successful_write_receipt_cannot_change_the_addressed_file_or_declare_a_directory() {
    let source = MemorySource::new();
    let fs = mount(&source, false, 1024);
    source.forge_receipt(true);
    let error = fs
        .apply(
            "forged",
            &SourceChange::Write {
                path: "app.js".into(),
                expected: 1,
                offset: 0,
                bytes: b"new".to_vec(),
            },
        )
        .unwrap_err();
    assert_eq!(error.code, "SOURCE_FENCED");
}
