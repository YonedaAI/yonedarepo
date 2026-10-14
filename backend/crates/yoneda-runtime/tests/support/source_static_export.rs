use super::*;
#[test]
#[ignore = "Actual root Linux FUSE static-export integration; targeted diagnostic gate"]
fn actual_linux_eval_child_and_root_static_export_preserve_cow_and_nofollow_diagnostic() {
    use std::os::unix::process::CommandExt;
    assert_eq!(unsafe { libc::geteuid() }, 0, "Actual root Linux required");
    assert!(std::path::Path::new("/dev/fuse").exists());
    let server = MemorySource::new();
    server.seed("public/index.html", b"<html>frozen source</html>");
    server.seed("public/binary.bin", &[0xff, 0, 0x80]);
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let cow = source_workspace_eval::EvaluationSource::new(server.clone()).unwrap();
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
    let mount = SourceMount::mount(source, root.path()).unwrap();
    let child=Command::new("/bin/sh").current_dir(root.path()).uid(1000).gid(1000)
        .args(["-c", r#"test "$(cat public/index.html)" = '<html>frozen source</html>' && printf '<html>ephemeral build</html>' > public/index.html"#])
        .output().unwrap();
    assert!(child.status.success());
    let files = site::assets(root.path(), "public").unwrap();
    assert_eq!(
        files["index.html"].bytes().unwrap(),
        b"<html>ephemeral build</html>"
    );
    assert_eq!(files["binary.bin"].bytes().unwrap(), vec![0xff, 0, 0x80]);
    assert_eq!(server.mutations(), 0);
    // A normal read can follow an alias, but root export must keep O_NOFOLLOW.
    let alias_parent = tempfile::tempdir().unwrap();
    let alias = alias_parent.path().join("alias");
    std::os::unix::fs::symlink(root.path(), &alias).unwrap();
    assert_eq!(
        fs::read(alias.join("public/index.html")).unwrap(),
        b"<html>ephemeral build</html>"
    );
    let error = site::assets(&alias, "public").unwrap_err();
    let mut report = serde_json::json!({"commands":[{"name":"site","output":{"exit":0}}]});
    site::record_failure(&mut report, &error);
    let diagnostic = &report["static_export_diagnostic"];
    assert_eq!(diagnostic["stage"], "open_root");
    assert_eq!(diagnostic["code"], "IO");
    assert_eq!(diagnostic["path"], "public/binary.bin");
    assert!(diagnostic["errno"].is_i64());
    assert!(
        !report
            .to_string()
            .contains(alias_parent.path().to_str().unwrap())
    );
    assert_eq!(server.mutations(), 0);
    mount.close().unwrap();
    use source_client::SourceBackend;
    assert_eq!(
        server.read("public/index.html", 1, 0, 64).unwrap().bytes,
        b"<html>frozen source</html>"
    );
}
