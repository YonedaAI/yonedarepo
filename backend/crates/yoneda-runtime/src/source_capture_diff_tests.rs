use crate::source_capture_diff::{SnapshotFile, touched_diff};
use std::collections::BTreeMap;
fn file(root: &std::path::Path, name: &str, bytes: &[u8], executable: bool) -> SnapshotFile {
    let path = root.join(name);
    std::fs::write(&path, bytes).unwrap();
    SnapshotFile {
        file: path,
        executable,
    }
}

#[test]
fn touched_snapshots_produce_real_binary_delete_add_and_executable_patch() {
    let tmp = tempfile::tempdir().unwrap();
    let before = BTreeMap::from([
        (
            "old.bin".into(),
            file(tmp.path(), "old", &[0, 255, 128], false),
        ),
        (
            "script".into(),
            file(tmp.path(), "script-old", b"before\r\n", false),
        ),
    ]);
    let after = BTreeMap::from([
        (
            "new.bin".into(),
            file(tmp.path(), "new", &[0, 255, 129], true),
        ),
        (
            "script".into(),
            file(tmp.path(), "script-new", b"after\r\n", true),
        ),
    ]);
    let patch = touched_diff(&before, &after).unwrap();
    assert!(patch.contains("diff --git a/new.bin b/new.bin"));
    assert!(patch.contains("diff --git a/old.bin b/old.bin"));
    assert!(patch.contains("GIT binary patch"));
    assert!(patch.contains("old mode 100644\nnew mode 100755"));
    assert!(patch.contains("-before\r\n+after\r\n"));
    assert_eq!(
        patch,
        touched_diff(&before, &after).unwrap(),
        "diff must be deterministic"
    );
}

#[test]
fn agent_attributes_do_not_normalize_bytes_or_choose_diff_drivers() {
    let tmp = tempfile::tempdir().unwrap();
    let attrs = file(
        tmp.path(),
        "attributes",
        b"* text eol=lf diff=owned\n",
        false,
    );
    let before = BTreeMap::from([
        (".gitattributes".into(), attrs.clone()),
        (
            "data".into(),
            file(tmp.path(), "before", b"before\r\n", false),
        ),
    ]);
    let after = BTreeMap::from([
        (".gitattributes".into(), attrs),
        (
            "data".into(),
            file(tmp.path(), "after", b"after\r\n", false),
        ),
    ]);
    let patch = touched_diff(&before, &after).unwrap();
    assert!(
        patch.contains("-before\r\n+after\r\n"),
        "no CRLF normalization through agent attributes"
    );
    assert!(
        touched_diff(
            &BTreeMap::from([("../escape".into(), before["data"].clone())]),
            &BTreeMap::new()
        )
        .is_err()
    );
}

#[test]
fn tiny_touched_diff_equals_real_full_git_comparison_with_untouched_files() {
    use std::{os::unix::fs::PermissionsExt, process::Command};
    let tmp = tempfile::tempdir().unwrap();
    let full = tmp.path().join("full");
    std::fs::create_dir(&full).unwrap();
    let native = |args: &[&str]| {
        let out = Command::new("/usr/bin/git")
            .current_dir(&full)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", "/nonexistent")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.attributesFile=/dev/null",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    };
    native(&["init", "--template=", "--object-format=sha1"]);
    std::fs::create_dir_all(full.join(".git/info")).unwrap();
    std::fs::write(
        full.join(".git/info/attributes"),
        "* -filter -text -ident -eol -working-tree-encoding diff\nold.bin -diff\nnew.bin -diff\n",
    )
    .unwrap();
    for n in 0..100 {
        std::fs::write(full.join(format!("unread-{n}")), [42u8; 1024]).unwrap();
    }
    let before = BTreeMap::from([
        (
            "old.bin".into(),
            file(tmp.path(), "old-source", &[0, 255, 128], false),
        ),
        (
            "script".into(),
            file(tmp.path(), "old-script", b"before\r\n", false),
        ),
    ]);
    let after = BTreeMap::from([
        (
            "new.bin".into(),
            file(tmp.path(), "new-source", &[0, 255, 129], true),
        ),
        (
            "script".into(),
            file(tmp.path(), "new-script", b"after\r\n", true),
        ),
    ]);
    for (path, input) in &before {
        std::fs::copy(&input.file, full.join(path)).unwrap();
        std::fs::set_permissions(full.join(path), std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    native(&["add", "--force", "--all"]);
    let old = native(&["write-tree"]);
    for path in before.keys() {
        std::fs::remove_file(full.join(path)).unwrap();
    }
    for (path, input) in &after {
        std::fs::copy(&input.file, full.join(path)).unwrap();
        std::fs::set_permissions(
            full.join(path),
            std::fs::Permissions::from_mode(if input.executable { 0o755 } else { 0o644 }),
        )
        .unwrap();
    }
    native(&["add", "--force", "--all"]);
    let new = native(&["write-tree"]);
    let reference = native(&[
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        old.trim(),
        new.trim(),
    ]);
    assert_eq!(
        touched_diff(&before, &after).unwrap(),
        reference,
        "canonical full-tree diff matches touched-only snapshots byte for byte"
    );
}
