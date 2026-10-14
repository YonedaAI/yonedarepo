#![allow(dead_code)] // These modules are independently compiled before parent shared registration.
#[path = "support/http.rs"]
mod http;
#[path = "../src/source_client.rs"]
mod source_client;
#[path = "../src/source_client_api.rs"]
mod source_client_api;
#[path = "support/source_receipt_native.rs"]
mod source_receipt_native;
use source_client::{SourceBackend, SourceChange};
use source_client_api::ApiSourceClient;
use source_receipt_native::NativeReceiptServer;
use std::sync::Arc;

fn client(native: &NativeReceiptServer) -> Arc<ApiSourceClient> {
    ApiSourceClient::test_at(
        &native.server.origin,
        "repo",
        &native.workspace,
        &native.view_digest,
        false,
    )
    .unwrap()
}
fn write(client: &ApiSourceClient, id: &str, path: &str, bytes: &[u8]) -> u64 {
    let expected = client.stat(path).unwrap().version;
    let written = client
        .apply(
            id,
            &SourceChange::Write {
                path: path.into(),
                expected,
                offset: 0,
                bytes: bytes.to_vec(),
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(written.version, expected + 1);
    written.version
}
fn contents(client: &ApiSourceClient, path: &str) -> Vec<u8> {
    let node = client.stat(path).unwrap();
    client
        .read(path, node.version, 0, node.size as usize)
        .unwrap()
        .bytes
}

#[test]
fn metadata_mutations_without_uploads_accept_per_file_receipts() {
    let native = NativeReceiptServer::new();
    let client = client(&native);
    let mode = |id: &str, path: &str, expected: u64, mode: u32| {
        client.apply(
            id,
            &SourceChange::Mode {
                path: path.into(),
                expected,
                mode,
            },
        )
    };
    assert_eq!(
        mode("mode-a", "a.txt", 0, 0o100755)
            .unwrap()
            .unwrap()
            .version,
        1
    );
    assert_eq!(
        mode("mode-b", "b.txt", 0, 0o100755)
            .unwrap()
            .unwrap()
            .version,
        1
    );
    assert_eq!(
        mode("mode-a-2", "a.txt", 1, 0o100644)
            .unwrap()
            .unwrap()
            .version,
        2
    );
}
#[test]
fn sequential_writes_to_different_files_accept_per_file_receipts() {
    let native = NativeReceiptServer::new();
    let client = client(&native);
    assert_eq!(write(&client, "write-a", "a.txt", b"ALPHA"), 1);
    // Workspace is now 1 but b.txt has never changed, so its receipt version is 1, not 2.
    assert_eq!(write(&client, "write-b", "b.txt", b"BRAVO"), 1);
    assert_eq!(contents(&client, "a.txt"), b"ALPHA");
    assert_eq!(contents(&client, "b.txt"), b"BRAVO");
}
#[test]
fn repeated_writes_to_one_file_after_other_writes_accept_per_file_receipts() {
    let native = NativeReceiptServer::new();
    let client = client(&native);
    assert_eq!(write(&client, "write-a-1", "a.txt", b"one"), 1);
    assert_eq!(write(&client, "write-a-2", "a.txt", b"two"), 2);
    assert_eq!(write(&client, "write-b", "b.txt", b"BRAVO"), 1);
    assert_eq!(write(&client, "write-a-3", "a.txt", b"three"), 3);
    assert_eq!(contents(&client, "a.txt"), b"three");
}
#[test]
fn create_rename_mode_and_delete_after_other_writes_accept_per_file_receipts() {
    let native = NativeReceiptServer::new();
    let client = client(&native);
    write(&client, "write-a", "a.txt", b"ALPHA");
    let created = client
        .apply(
            "create-c",
            &SourceChange::Create {
                path: "c.txt".into(),
                mode: 0o100644,
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!((created.version, created.size), (1, 0));
    let mode = client
        .apply(
            "mode-b",
            &SourceChange::Mode {
                path: "b.txt".into(),
                expected: 0,
                mode: 0o100755,
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!((mode.version, mode.mode), (1, 0o100755));
    let renamed = client
        .apply(
            "rename-a",
            &SourceChange::Rename {
                path: "a.txt".into(),
                expected: 1,
                target: "d.txt".into(),
                target_expected: None,
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(renamed.version, 1);
    assert_eq!(contents(&client, "d.txt"), b"ALPHA");
    assert_eq!(
        client
            .apply(
                "delete-c",
                &SourceChange::Delete {
                    path: "c.txt".into(),
                    expected: 1,
                },
            )
            .unwrap(),
        None
    );
    assert_eq!(client.stat("c.txt").unwrap_err().code, "SOURCE_NOT_FOUND");
}
#[test]
fn receipt_for_a_path_the_client_did_not_expect_is_still_fenced() {
    let native = NativeReceiptServer::new();
    let client = client(&native);
    write(&client, "write-a", "a.txt", b"ALPHA");
    // A stale caller expectation is a conflict, never a silently accepted receipt.
    assert_eq!(
        client
            .apply(
                "stale-b",
                &SourceChange::Write {
                    path: "b.txt".into(),
                    expected: 1,
                    offset: 0,
                    bytes: b"x".to_vec(),
                },
            )
            .unwrap_err()
            .code,
        "FILE_VERSION_CONFLICT"
    );
}
