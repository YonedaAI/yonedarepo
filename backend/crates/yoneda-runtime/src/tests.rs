use yoneda_core::{FileEntry, Workspace};

use crate::*;
use serde_json::json;
use tokio::process::Command;
#[path = "tests/context_study_prompt.rs"]
mod context_study_prompt;
#[path = "tests/process_transport.rs"]
mod process_transport;
#[cfg(target_os = "linux")]
#[tokio::test]
async fn supervisor_refuses_jobs_without_owning_the_agent_uid() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let error = crate::supervisor::serve().await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("must own the isolated agent UID")
    );
}

#[tokio::test]
async fn claude_child_uses_the_same_output_ceiling_as_the_provider_proxy() {
    let mut child = Command::new("/bin/sh");
    crate::process::untrusted(&mut child, std::path::Path::new("/tmp"));
    child.args([
        "-c",
        "printf '%s:%s' \"$CLAUDE_CODE_MAX_OUTPUT_TOKENS\" \"$CLAUDE_CODE_EFFORT_LEVEL\"",
    ]);
    let result = child.output().await.unwrap();
    assert!(result.status.success());
    assert_eq!(String::from_utf8(result.stdout).unwrap(), "4096:low");
}
#[test]
fn website_prompt_uses_approved_brief_and_context_without_fixture_requirements() {
    let payload = json!({"execution":{"role":"coding","strategy":"accessible"},"run":{"id":"site","intent":"Build a portfolio website","criteria":["Keyboard navigation"],"context_records":[{"label":"Use semantic HTML"}]},"policy":{"build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}});
    let prompt = crate::prompt::prompt(&payload).unwrap();
    assert!(prompt.contains("Keyboard navigation"));
    assert!(prompt.contains("Use semantic HTML"));
    assert!(prompt.contains("context_publish"));
    assert!(!prompt.contains("retry-client"));
    assert!(!prompt.contains("upstream_p99_ms"));
}
#[tokio::test]
async fn general_build_runs_checks_and_preserves_failure_and_timeout_observations() {
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
    }
    let profile = serde_json::from_value(json!({"setup":[{"name":"prepare","argv":["/bin/sh","-c","echo ready > ready.txt"],"timeout_seconds":1}],"checks":[{"name":"build","argv":["/bin/sh","-c","test -f ready.txt"],"timeout_seconds":1},{"name":"test","argv":["/bin/sh","-c","exit 7"],"timeout_seconds":1},{"name":"bounded","argv":["/bin/sh","-c","sleep 20"],"timeout_seconds":1}]})).unwrap();
    let report = crate::evaluation::run_profile(root.path(), &profile)
        .await
        .unwrap();
    assert_eq!(report["setup"][0]["output"]["exit"], 0);
    assert_eq!(report["commands"][0]["output"]["exit"], 0);
    assert_eq!(report["commands"][1]["output"]["exit"], 7);
    assert_eq!(report["commands"][2]["output"]["timeout"], true);
}
#[test]
fn binary_source_roundtrips_without_loss() {
    let root = tempfile::tempdir().unwrap();
    let bytes = [0x89, b'P', b'N', b'G', 0, 0xff, 0x80];
    std::fs::write(root.path().join("image.png"), bytes).unwrap();
    let exported = export_workspace(root.path()).unwrap();
    let destination = tempfile::tempdir().unwrap();
    materialize(destination.path(), &exported).unwrap();
    assert_eq!(
        std::fs::read(destination.path().join("image.png")).unwrap(),
        bytes
    );
}
#[tokio::test]
async fn capture_keeps_validated_files_even_if_candidate_gitignore_excludes_them() {
    let root = tempfile::tempdir().unwrap();
    let workspace: Workspace = serde_json::from_value(json!({".gitignore":{"content":"*.png\n"},"logo.png":{"content":"iVBORwD/gA==","encoding":"base64"}})).unwrap();
    capture(root.path(), None, &workspace, "Binary asset")
        .await
        .unwrap();
    let paths = git(root.path(), &["ls-tree", "-r", "--name-only", "HEAD"])
        .await
        .unwrap();
    assert!(paths.contains("logo.png"));
}
#[test]
fn source_export_preserves_baseline_files_and_excludes_new_ignored_outputs() {
    let root = tempfile::tempdir().unwrap();
    let baseline: Workspace = serde_json::from_value(json!({".gitignore":{"content":"dist/\nnode_modules/\n"},"node_modules/owned.txt":{"content":"tracked"},"src/main.js":{"content":"source"}})).unwrap();
    materialize(root.path(), &baseline).unwrap();
    std::fs::create_dir_all(root.path().join("dist")).unwrap();
    std::fs::write(root.path().join("dist/index.html"), "built output").unwrap();
    std::fs::write(root.path().join("node_modules/generated.txt"), "dependency").unwrap();
    let result = crate::workspace::export_with_baseline(root.path(), &baseline).unwrap();
    assert!(result.contains_key("node_modules/owned.txt"));
    assert!(!result.contains_key("dist/index.html"));
    assert!(!result.contains_key("node_modules/generated.txt"));
}
#[test]
fn workspace_roundtrips_and_rejects_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::new();
    workspace.insert(
        "src/main.rs".into(),
        FileEntry {
            content: "fn main() {}\n".into(),
            executable: false,
            encoding: None,
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
            encoding: None,
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
            encoding: None,
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
                    encoding: None,
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
    assert_eq!(health["capabilities"]["context_usage"], 1);
    assert_eq!(health["capabilities"]["context_study"], 1);
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

#[test]
fn static_assets_capture_ignored_outputs_but_reject_symlink_directories() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("dist")).unwrap();
    std::fs::write(root.path().join(".gitignore"), "dist/\n").unwrap();
    std::fs::write(root.path().join("dist/index.html"), "<html>Built</html>").unwrap();
    std::fs::write(root.path().join("dist/logo.png"), [0xff, 0, 0x80]).unwrap();
    let files = crate::site::assets(root.path(), "dist").unwrap();
    assert_eq!(files["logo.png"].bytes().unwrap(), vec![0xff, 0, 0x80]);
    assert!(crate::site::assets(root.path(), "../dist").is_err());
    std::os::unix::fs::symlink(root.path().join("dist"), root.path().join("linked")).unwrap();
    assert!(crate::site::assets(root.path(), "linked").is_err());
    std::os::unix::fs::symlink("/etc/passwd", root.path().join("dist/secret")).unwrap();
    assert!(crate::site::assets(root.path(), "dist").is_err());
}

#[tokio::test]
async fn primary_exit_kills_background_pipe_holders_before_drain() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "printf 'primary finished'; sleep 30 & exit 7"]);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        crate::process::bounded_output(&mut command),
    )
    .await
    .expect("Background descendants must not hold output pipes until the execution deadline")
    .unwrap();
    assert_eq!(result["exit"], 7);
    assert_eq!(result["stdout"], "primary finished");
}
