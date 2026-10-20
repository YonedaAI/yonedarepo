use super::*;
use yoneda_agents_core::FileEntry;

fn setup() -> (tempfile::TempDir, String) {
    let root = tempfile::tempdir().unwrap();
    let files = Workspace::from([
        (
            "src/main.rs".into(),
            FileEntry::from_bytes(b"captured".to_vec(), false),
        ),
        (
            ".gitignore".into(),
            FileEntry::from_bytes(b"ignored\n".to_vec(), false),
        ),
    ]);
    let digest = materialize(root.path(), &[("candidate".into(), files)]).unwrap();
    (root, digest)
}
fn unlock(root: &Path) {
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.unwrap();
        if entry.file_type().is_dir() {
            fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}
fn relock(root: &Path) {
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.unwrap();
        if entry.file_type().is_dir() {
            fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o555)).unwrap();
        }
    }
}
#[test]
fn captured_checkout_is_immutable_and_checks_ignored_files_and_permissions() {
    let (root, digest) = setup();
    verify(root.path(), &digest).unwrap();
    assert_eq!(
        fs::metadata(root.path().join("candidate-0/src/main.rs"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o444
    );
    unlock(root.path());
    fs::write(root.path().join("candidate-0/ignored"), "unapproved").unwrap();
    relock(root.path());
    assert!(verify(root.path(), &digest).is_err());
    unlock(root.path());
}
#[test]
fn checkout_rejects_source_substitution_symlinks_and_nonempty_roots() {
    let (root, digest) = setup();
    unlock(root.path());
    let file = root.path().join("candidate-0/src/main.rs");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(&file, "changed").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o444)).unwrap();
    relock(root.path());
    assert!(verify(root.path(), &digest).is_err());
    unlock(root.path());
    fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", &file).unwrap();
    assert!(verify(root.path(), &digest).is_err());
    assert!(materialize(root.path(), &[]).is_err());
}
#[cfg(target_os = "linux")]
#[test]
fn linux_agent_uid_cannot_modify_supervisor_owned_captured_sources() {
    use std::os::unix::process::CommandExt;
    if unsafe { libc::geteuid() } != 0 {
        return;
    }
    let (root, digest) = setup();
    let output = std::process::Command::new("/bin/sh")
        .uid(1000)
        .gid(1000)
        .arg("-c")
        .arg("cat candidate-0/src/main.rs && printf forged >candidate-0/src/main.rs")
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "captured");
    verify(root.path(), &digest).unwrap();
    unlock(root.path());
}
