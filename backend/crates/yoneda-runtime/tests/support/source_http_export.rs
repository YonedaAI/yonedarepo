use super::*;
#[test]
#[ignore = "Actual Linux FUSE and native-ledger HTTP export regression"]
fn actual_linux_http_directory_export_after_checks_preserves_remote_version_and_cow() {
    use source_client::SourceBackend;
    use std::os::unix::process::CommandExt;
    assert_eq!(unsafe { libc::geteuid() }, 0);
    assert!(std::path::Path::new("/dev/fuse").exists());
    let fixture = source_native_http::NativeSourceServer::new();
    let client = source_client_api::ApiSourceClient::test_root_at(
        &fixture.server.origin,
        "repo",
        &fixture.workspace,
        &fixture.view_digest,
        true,
        "fixture-root-only",
    )
    .unwrap();
    assert_eq!(client.stat("public").unwrap().version, 1);
    let cow = source_workspace_eval::EvaluationSource::new(client.clone()).unwrap();
    assert_eq!(
        cow.stat("public").unwrap().version,
        0,
        "COW version is independent of remote version"
    );
    let source = Arc::new(
        SourceWorkspace::new(
            cow,
            false,
            true,
            Arc::new(SourceCancellation::default()),
            1024,
        )
        .unwrap(),
    );
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let mount = SourceMount::mount(source, root.path()).unwrap();
    let child = Command::new("/bin/sh").current_dir(root.path()).uid(1000).gid(1000)
        .args(["-c", "test \"$(cat public/index.html)\" = '<html>frozen source</html>' && printf '<html>ephemeral build</html>' > public/index.html"])
        .output().unwrap();
    assert!(
        child.status.success(),
        "Known-path protected check must pass before export"
    );
    let exported = site::assets(root.path(), "public").unwrap();
    assert_eq!(exported.len(), 2);
    assert_eq!(
        exported["index.html"].bytes().unwrap(),
        b"<html>ephemeral build</html>"
    );
    assert_eq!(
        exported["nested/data.bin"].bytes().unwrap(),
        vec![0xff, 0, 0x80]
    );
    assert_eq!(client.stat("public").unwrap().version, 1);
    assert_eq!(
        client.read("public/index.html", 1, 0, 64).unwrap().bytes,
        b"<html>frozen source</html>"
    );
    let requests = fixture.server.requests.lock().unwrap();
    let lists: Vec<_> = requests
        .iter()
        .filter(|r| r.starts_with("POST /v1/repo/source_list "))
        .collect();
    assert!(!lists.is_empty());
    assert!(
        lists
            .iter()
            .all(|r| r.contains("\"expected_workspace_version\":1"))
    );
    assert!(lists.iter().any(|r| r.contains("\"prefix\":\"public/\"")));
    assert!(
        lists
            .iter()
            .any(|r| r.contains("\"prefix\":\"public/nested/\""))
    );
    drop(requests);
    mount.close().unwrap();
}
