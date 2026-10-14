#![allow(dead_code)] // Path modules compile focused mechanics independently of shared runtime registration.
#[path = "../src/source_client.rs"]
mod source_client;
#[path = "../src/source_workspace.rs"]
mod source_workspace;
#[path = "../src/source_workspace_directories.rs"]
mod source_workspace_directories;
mod support;
use source_client::SourceCancellation;
use source_workspace::SourceWorkspace;
use source_workspace_directories::LocalDirectories;
use std::sync::Arc;
use support::MemorySource;

fn directories(source: &Arc<MemorySource>, readonly: bool) -> LocalDirectories {
    LocalDirectories::new(Arc::new(
        SourceWorkspace::new(
            source.clone(),
            readonly,
            true,
            Arc::new(SourceCancellation::default()),
            1024,
        )
        .unwrap(),
    ))
}
#[test]
fn empty_directory_is_only_local_metadata_and_nested_empty_remove_is_guarded() {
    let server = MemorySource::new();
    let dirs = directories(&server, false);
    assert!(dirs.mkdir("src").unwrap().directory());
    dirs.mkdir("src/nested").unwrap();
    assert_eq!(dirs.list("src").unwrap()[0].path, "src/nested");
    assert_eq!(dirs.rmdir("src").unwrap_err().code, "SOURCE_NOT_EMPTY");
    assert_eq!(server.mutations(), 0);
    assert_eq!(server.reads(), 0);
    dirs.rmdir("src/nested").unwrap();
    dirs.rmdir("src").unwrap();
    assert_eq!(dirs.stat("src").unwrap_err().code, "SOURCE_NOT_FOUND");
    assert_eq!(
        directories(&server, false).stat("src").unwrap_err().code,
        "SOURCE_NOT_FOUND"
    );
}
#[test]
fn local_directory_never_overrides_authoritative_file_and_readonly_cannot_create() {
    let server = MemorySource::new();
    let dirs = directories(&server, false);
    assert_eq!(dirs.mkdir("app.js").unwrap_err().code, "ALREADY_EXISTS");
    assert!(!dirs.stat("app.js").unwrap().directory());
    assert_eq!(
        directories(&server, true).mkdir("src").unwrap_err().code,
        "SOURCE_READ_ONLY"
    );
    assert_eq!(server.mutations(), 0);
}
