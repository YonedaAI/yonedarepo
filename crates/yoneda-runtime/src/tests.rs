use yoneda_core::{FileEntry, Workspace};

use crate::*;
use serde_json::json;
use tokio::process::Command;
#[test]
fn workspace_roundtrips_and_rejects_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::new();
    workspace.insert(
        "src/main.rs".into(),
        FileEntry {
            content: "fn main() {}\n".into(),
            executable: false,
        },
    );
    materialize(dir.path(), &workspace).unwrap();
    assert_eq!(
        serde_json::to_value(export_workspace(dir.path()).unwrap()).unwrap(),
        serde_json::to_value(workspace).unwrap()
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("secret")).unwrap();
        assert!(export_workspace(dir.path()).is_err());
    }
}
#[tokio::test]
async fn capture_is_deterministic_and_preserves_parent_and_deletions() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let workspace = Workspace::from([(
        "a.txt".into(),
        FileEntry {
            content: "original".into(),
            executable: false,
        },
    )]);
    let first = capture(a.path(), None, &workspace, "Seed").await.unwrap();
    let second = capture(b.path(), None, &workspace, "Seed").await.unwrap();
    assert_eq!(first["commit"], second["commit"]);
    let c = tempfile::tempdir().unwrap();
    git(c.path(), &["init", "-b", "main"]).await.unwrap();
    // Local file transport is enabled only by this test's command, never by the production helper.
    let status = Command::new("git")
        .current_dir(c.path())
        .args(["fetch", a.path().to_str().unwrap(), "main"])
        .status()
        .await
        .unwrap();
    assert!(status.success());
    let replacement = Workspace::from([(
        "b.txt".into(),
        FileEntry {
            content: "new".into(),
            executable: false,
        },
    )]);
    let result = capture(
        c.path(),
        Some(first["commit"].as_str().unwrap()),
        &replacement,
        "Candidate",
    )
    .await
    .unwrap();
    assert_eq!(
        git(c.path(), &["rev-parse", "HEAD^"]).await.unwrap(),
        first["commit"].as_str().unwrap()
    );
    assert_eq!(result["paths"], json!(["a.txt", "b.txt"]));
    assert_eq!(
        git(c.path(), &["ls-tree", "-r", "--name-only", "HEAD"])
            .await
            .unwrap(),
        "b.txt"
    );
}

#[tokio::test]
async fn command_completion_stops_background_children() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("escaped-child");
    let mut command = Command::new("sh");
    command
        .args([
            "-c",
            "(sleep 0.2; echo escaped > \"$1\") >/dev/null 2>&1 &",
            "test",
        ])
        .arg(&marker);
    crate::process::bounded_output(&mut command).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(
        !marker.exists(),
        "Child must not outlive its supervised command"
    );
}

#[tokio::test]
async fn capture_preserves_raw_unicode_and_control_character_paths() {
    let root = tempfile::tempdir().unwrap();
    let names = ["café.rs", "quote\".txt", "tab\t.txt", "line\n.txt"];
    let workspace = names
        .iter()
        .map(|name| {
            (
                name.to_string(),
                FileEntry {
                    content: "text".into(),
                    executable: false,
                },
            )
        })
        .collect();
    let result = capture(root.path(), None, &workspace, "Paths")
        .await
        .unwrap();
    let actual: std::collections::BTreeSet<_> = result["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    assert_eq!(actual, names.into_iter().collect());
}

#[cfg(target_os = "linux")]
#[test]
fn detached_child_fixture() {
    let Ok(marker) = std::env::var("YONEDA_TEST_DAEMON") else {
        return;
    };
    let marker = std::ffi::CString::new(marker).unwrap();
    // The child deliberately leaves its parent's process group and closes all pipes.
    unsafe {
        let pid = libc::fork();
        assert!(pid >= 0);
        if pid == 0 {
            libc::setsid();
            libc::close(0);
            libc::close(1);
            libc::close(2);
            libc::usleep(200_000);
            let fd = libc::open(marker.as_ptr(), libc::O_WRONLY | libc::O_CREAT, 0o600);
            if fd >= 0 {
                libc::write(fd, b"escaped".as_ptr().cast(), 7);
                libc::close(fd);
            }
            libc::_exit(0);
        }
    }
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn isolated_uid_barrier_stops_daemonized_descendants() {
    if unsafe { libc::geteuid() } != 0 {
        return;
    } // The Docker build runs this as root on Linux.
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
    let marker = root.path().join("daemon");
    let mut command = Command::new(std::env::current_exe().unwrap());
    crate::process::untrusted(&mut command, root.path());
    command
        .args(["--exact", "tests::detached_child_fixture", "--nocapture"])
        .env("YONEDA_TEST_DAEMON", &marker);
    let result = crate::process::bounded_output(&mut command).await.unwrap();
    assert_eq!(result["exit"], 0, "{result}");
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(
        !marker.exists(),
        "Daemonized child survived the command barrier"
    );
}

#[test]
fn runtime_health_identifies_protocol_and_evaluator_environment() {
    let health = crate::supervisor::health();
    assert_eq!(health["protocol"], 2);
    assert_eq!(
        health["environment"],
        yoneda_core::Policy::default().environment
    );
    assert!(
        health["suites"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "retry-contract-v2")
    );
}
