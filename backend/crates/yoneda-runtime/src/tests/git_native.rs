use crate::{capture, git, git::capture_fresh};
use serde_json::json;
use std::{collections::BTreeMap, io::Write};
use yoneda_core::{FileEntry, Workspace};

#[tokio::test]
async fn fresh_capture_preserves_large_binary_modes_and_base_history_without_agent_config() {
    let canonical = tempfile::tempdir().unwrap();
    let base_files = Workspace::from([(
        "README".into(),
        FileEntry::from_bytes(b"base".to_vec(), false),
    )]);
    let base = capture(canonical.path(), None, &base_files, "approved base")
        .await
        .unwrap();
    let agent = tempfile::tempdir().unwrap();
    git(agent.path(), &["init", "-b", "main"]).await.unwrap();
    let marker = agent.path().join("filter-ran");
    let config = format!(
        "[filter \"owned\"]\n\tclean = sh -c 'touch {} ; cat'\n",
        marker.display()
    );
    std::fs::write(agent.path().join(".git/config"), config).unwrap();

    let mut files = BTreeMap::new();
    files.insert(
        "README".into(),
        FileEntry::from_bytes(b"candidate base file".to_vec(), false),
    );
    files.insert(
        ".gitattributes".into(),
        FileEntry::from_bytes(b"payload.bin filter=owned\n".to_vec(), false),
    );
    files.insert(
        "payload.bin".into(),
        FileEntry::from_bytes(vec![0, 255, 128, 42], true),
    );
    for index in 0..600 {
        files.insert(
            format!("src/{index:04}.dat"),
            FileEntry::from_bytes(vec![u8::try_from(index % 256).unwrap(); 16_000], false),
        );
    }
    let files = crate::transport::from_legacy(files).unwrap();
    let total: usize = files.values().map(|file| file.bytes.len()).sum();
    assert!(total > 8 * 1024 * 1024);
    let captured = capture_fresh(
        agent.path(),
        canonical.path().to_str().unwrap(),
        base["commit"].as_str().unwrap(),
        &files,
        "trusted capture",
    )
    .await
    .unwrap();
    let diff = captured["diff"].as_str().unwrap();
    assert!(
        diff.starts_with("diff --git a/"),
        "capture must retain a reviewable patch"
    );
    assert!(
        diff.contains("candidate base file"),
        "text changes must be present in the patch"
    );
    assert!(
        diff.contains("GIT binary patch"),
        "binary changes must use Git's binary-safe encoding"
    );
    assert!(
        diff.len() <= 24 * 1024 * 1024,
        "stored patches must fit the Worker evidence limit"
    );
    assert!(
        !marker.exists(),
        "agent-defined Git filters must never execute during capture"
    );
    assert_eq!(
        git(agent.path(), &["rev-parse", "HEAD^"]).await.unwrap(),
        base["commit"].as_str().unwrap()
    );
    assert_eq!(
        git(agent.path(), &["ls-tree", "HEAD", "payload.bin"])
            .await
            .unwrap()
            .split_whitespace()
            .next(),
        Some("100755")
    );
    let loaded = crate::git::read_git_revision(
        agent.path().to_str().unwrap(),
        captured["commit"].as_str().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(loaded.len(), 603);
    assert_eq!(loaded["payload.bin"].bytes, [0, 255, 128, 42]);
    assert!(loaded["payload.bin"].executable);
    assert_eq!(loaded["README"].bytes, b"candidate base file");
}

#[tokio::test]
async fn fresh_capture_rejects_review_patch_over_worker_limit_without_truncating() {
    let canonical = tempfile::tempdir().unwrap();
    let base_files = Workspace::from([(
        "base.txt".into(),
        yoneda_core::FileEntry::from_bytes(b"approved".to_vec(), false),
    )]);
    let base = capture(canonical.path(), None, &base_files, "approved empty base")
        .await
        .unwrap();
    let mut state = 0x1234_5678_u32;
    let bytes = (0..25 * 1024 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 24) as u8
        })
        .collect::<Vec<_>>();
    let files = BTreeMap::from([(
        "large.bin".into(),
        crate::transport::GitFile {
            bytes,
            executable: false,
        },
    )]);
    let target = tempfile::tempdir().unwrap();
    let error = capture_fresh(
        target.path(),
        canonical.path().to_str().unwrap(),
        base["commit"].as_str().unwrap(),
        &files,
        "oversized review patch",
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("24 MiB review limit"), "{error}");
}

#[tokio::test]
async fn legacy_capture_discards_untrusted_local_filter_configuration() {
    let root = tempfile::tempdir().unwrap();
    let git_dir = root.path().join(".git");
    std::fs::create_dir_all(&git_dir).unwrap();
    let marker = root.path().join("filter-ran");
    std::fs::write(
        git_dir.join("config"),
        format!(
            "[filter \"owned\"]\n\tclean = sh -c 'touch {} ; cat'\n",
            marker.display()
        ),
    )
    .unwrap();
    let files = Workspace::from([
        (
            ".gitattributes".into(),
            FileEntry::from_bytes(b"payload.bin filter=owned\n".to_vec(), false),
        ),
        (
            "payload.bin".into(),
            FileEntry::from_bytes(vec![0, 255, 128], false),
        ),
    ]);
    capture(root.path(), None, &files, "legacy capture")
        .await
        .unwrap();
    assert!(!marker.exists(), "untrusted Git filters must never execute");
}

#[test]
fn transport_discriminator_is_read_only_and_missing_value_keeps_legacy_mode() {
    assert!(crate::transport::enabled(
        &json!({"payload":{"workspace_transport":"git-native-v1"}})
    ));
    assert!(!crate::transport::enabled(&json!({"payload":{}})));
    assert!(!crate::transport::enabled(
        &json!({"payload":{"workspace_transport":"other"}})
    ));
}

#[tokio::test]
async fn planner_snapshot_rejects_dirty_files_and_untrusted_git_config() {
    let root = tempfile::tempdir().unwrap();
    let approved = Workspace::from([(
        "src/main.rs".into(),
        FileEntry::from_bytes(b"fn main() {}\n".to_vec(), false),
    )]);
    crate::git::capture(root.path(), None, &approved, "approved")
        .await
        .unwrap();
    let snapshot = crate::transport::snapshot_read_only(root.path())
        .await
        .unwrap();
    crate::transport::verify_read_only(root.path(), &snapshot)
        .await
        .unwrap();

    std::fs::write(root.path().join("src/main.rs"), b"changed\n").unwrap();
    assert!(
        crate::transport::verify_read_only(root.path(), &snapshot)
            .await
            .is_err()
    );
    std::fs::write(root.path().join("src/main.rs"), b"fn main() {}\n").unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            root.path().join("src/main.rs"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(root.path().join(".git/config"))
            .unwrap()
            .write_all(b"\n[core]\nfileMode = false\nfsmonitor = !touch /tmp/yoneda-git-planner-config-ran\n")
            .unwrap();
        assert!(
            crate::transport::verify_read_only(root.path(), &snapshot)
                .await
                .is_err()
        );
        assert!(!std::path::Path::new("/tmp/yoneda-git-planner-config-ran").exists());
    }

    std::fs::write(root.path().join(".git/info/exclude"), "planner-output\n").unwrap();
    std::fs::write(root.path().join("planner-output"), "untracked").unwrap();
    assert!(
        crate::transport::verify_read_only(root.path(), &snapshot)
            .await
            .is_err()
    );
}
