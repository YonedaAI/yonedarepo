use super::*;
use base64::Engine;

fn encoded(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[test]
fn staged_files_are_restored_into_the_new_workspace_and_the_prompt_says_continue() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("stale.txt"), b"old").unwrap();
    let manifest = json!({"version":1,"epoch":1,"reason":"EXECUTION_TIMEOUT",
        "files":[
            {"path":"public/index.html","mode":"100644","content_base64":encoded(b"<h1>Laundry</h1>")},
            {"path":"public/order.js","mode":"100755","content_base64":encoded(b"export const total = 1;")},
            {"path":"../escape.txt","mode":"100644","content_base64":encoded(b"x")},
            {"path":"public/bad.js","mode":"100644","content_base64":"%%%not base64"}],
        "deleted":["stale.txt","never-existed.txt"],"skipped":["public/huge.bin"]});
    let restored = apply(root.path(), &manifest).unwrap();
    assert_eq!(restored.written, ["public/index.html", "public/order.js"]);
    assert_eq!(restored.removed, ["stale.txt", "never-existed.txt"]);
    assert_eq!(
        restored.skipped,
        ["../escape.txt", "public/bad.js", "public/huge.bin"]
    );
    assert_eq!(
        std::fs::read(root.path().join("public/index.html")).unwrap(),
        b"<h1>Laundry</h1>"
    );
    assert!(!root.path().join("stale.txt").exists());
    assert!(!root.path().parent().unwrap().join("escape.txt").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(root.path().join("public/order.js"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }
    let text = note(&manifest, &restored).unwrap();
    assert!(text.starts_with("Resuming this task."));
    assert!(text.contains("EXECUTION_TIMEOUT"));
    assert!(text.contains("public/index.html, public/order.js"));
    assert!(text.contains("3 file(s) could not be restored"));
    assert!(text.contains("Do not start over"));
}

#[test]
fn nothing_to_restore_leaves_the_prompt_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let manifest =
        json!({"version":1,"epoch":null,"reason":null,"files":[],"deleted":[],"skipped":[]});
    let restored = apply(root.path(), &manifest).unwrap();
    assert_eq!(restored, Restored::default());
    assert!(note(&manifest, &restored).is_none());
}

#[tokio::test]
async fn jobs_without_a_recorded_checkpoint_never_call_the_broker() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        restore(&json!({"kind":"agent","resume":null}), root.path())
            .await
            .is_none()
    );
}
