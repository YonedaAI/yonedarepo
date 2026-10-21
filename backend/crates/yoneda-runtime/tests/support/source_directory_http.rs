use super::{http::*, source_client::SourceBackend, source_client_api::ApiSourceClient};
use serde_json::json;
#[test]
fn directory_prefix_uses_native_child_boundary_not_textual_siblings() {
    let fixture = super::source_native_http::NativeSourceServer::new();
    let client = ApiSourceClient::test_at(
        &fixture.server.origin,
        "repo",
        &fixture.workspace,
        &fixture.view_digest,
        true,
    )
    .unwrap();
    assert_eq!(client.stat("public").unwrap().version, 1);
    let root = client.list("").unwrap();
    assert_eq!(
        root.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(),
        ["public", "public-sibling"]
    );
    let children = client.list("public").unwrap();
    assert_eq!(
        children.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(),
        ["public/index.html", "public/nested"]
    );
    let nested = client.list("public/nested").unwrap();
    assert_eq!(nested.len(), 1);
    assert_eq!(nested[0].path, "public/nested/data.bin");
    assert!(!nested[0].directory());
    let requests = fixture.server.requests.lock().unwrap();
    assert!(
        !requests
            .iter()
            .any(|r| r.starts_with("POST /v1/repo/source_read ")),
        "Directory traversal must remain metadata-only"
    );
}
#[test]
fn directory_second_page_changed_remote_version_remains_fenced() {
    let mut current = status();
    current["workspace_version"] = json!(7);
    let first = json!({"workspace_id":"ws","workspace_version":7,"items":[{"path":"public/a","kind":"file","exists":true,"file_version":0,"mode":"100644","size":1}],"next_cursor":"next"});
    let changed = json!({"workspace_id":"ws","workspace_version":8,"items":[],"next_cursor":null});
    // Listing costs no status round trip: the first page names the version (7) and every
    // later page must carry and return it, so a remote change between pages still fences.
    let server = Server::new(vec![
        Response::json(current),
        Response::json(first),
        Response::json(changed),
    ]);
    let client = ApiSourceClient::test_at(&server.origin, "repo", "ws", "view", false).unwrap();
    assert_eq!(client.list("public").unwrap_err().code, "SOURCE_FENCED");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[0].starts_with("POST /v1/repo/source_status "));
    let lists: Vec<_> = requests
        .iter()
        .filter(|r| r.starts_with("POST /v1/repo/source_list "))
        .collect();
    assert_eq!(lists.len(), 2);
    assert!(lists.iter().all(|r| r.contains("\"prefix\":\"public/\"")));
    assert!(!lists[0].contains("expected_workspace_version"));
    assert!(lists[1].contains("\"expected_workspace_version\":7"));
}
