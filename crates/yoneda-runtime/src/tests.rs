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
