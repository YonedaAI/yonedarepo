use crate::conflict_merge::{execute_refresh_job, refresh};
use serde_json::json;
use std::{fs, path::Path, process::Command};
use tempfile::tempdir;

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args(args)
        .current_dir(root)
        .output()
        .expect("git installed");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn history() -> (tempfile::TempDir, String, String, String) {
    let root = tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    git(
        root.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "config",
            "commit.gpgsign",
            "false",
        ],
    );
    fs::write(root.path().join("shared.txt"), "base\n").unwrap();
    git(root.path(), &["add", "."]);
    git(
        root.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "base",
        ],
    );
    let base = git(root.path(), &["rev-parse", "HEAD"]);
    git(root.path(), &["checkout", "-b", "head"]);
    fs::write(root.path().join("shared.txt"), "head\n").unwrap();
    git(
        root.path(),
        &[
            "commit",
            "-am",
            "head",
            "--author=Test <test@example.invalid>",
        ],
    );
    let head = git(root.path(), &["rev-parse", "HEAD"]);
    git(root.path(), &["checkout", "-b", "candidate", &base]);
    fs::write(root.path().join("candidate.txt"), "candidate\n").unwrap();
    git(root.path(), &["add", "."]);
    git(
        root.path(),
        &[
            "commit",
            "-m",
            "candidate",
            "--author=Test <test@example.invalid>",
        ],
    );
    let candidate = git(root.path(), &["rev-parse", "HEAD"]);
    (root, base, head, candidate)
}

#[tokio::test]
async fn disjoint_head_move_produces_merge_commit_with_both_parents() {
    let (root, base, head, candidate) = history();
    let result = refresh(
        root.path(),
        &base,
        &head,
        &candidate,
        "fork/repo",
        &["candidate.txt".into()],
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "clean");
    assert_eq!(
        result["evidence"]["captured_paths"],
        json!(["candidate.txt"])
    );
    assert_eq!(
        result["evidence"]["intervening_paths"],
        json!(["shared.txt"])
    );
    let parents = git(
        root.path(),
        &[
            "show",
            "-s",
            "--format=%P",
            result["merge_commit"].as_str().unwrap(),
        ],
    );
    let parents: Vec<_> = parents.split_whitespace().collect();
    assert_eq!(parents, vec![head.as_str(), candidate.as_str()]);
    assert!(
        crate::git_revision::verify_git_parent(
            root.path().to_str().unwrap(),
            result["merge_commit"].as_str().unwrap(),
            &head,
        )
        .await
        .is_err(),
        "Ordinary candidates must keep the single-parent invariant"
    );
    crate::git_revision::verify_git_parents(
        root.path().to_str().unwrap(),
        result["merge_commit"].as_str().unwrap(),
        &[&head, &candidate],
    )
    .await
    .unwrap();
    assert!(
        crate::git_revision::verify_git_parents(
            root.path().to_str().unwrap(),
            result["merge_commit"].as_str().unwrap(),
            &[&candidate, &head],
        )
        .await
        .is_err(),
        "Frozen parent order must be exact"
    );
}

#[tokio::test]
async fn capture_subtype_dispatch_executes_the_reserved_refresh_job() {
    let (root, base, head, candidate) = history();
    let job = json!({"kind":"capture","payload":{"capture_subtype":"refresh_candidate","expected_base":base,"expected_head":head,"candidate":{"revision":{"repository":"fork/repo","commit":candidate}},"declared_paths":["candidate.txt"]}});
    let result = execute_refresh_job(&job, root.path()).await.unwrap();
    assert_eq!(result["status"], "clean");
    assert_eq!(
        result["evidence"]["captured_paths"],
        json!(["candidate.txt"])
    );
    let wrong_kind = json!({"kind":"agent","payload":{"capture_subtype":"refresh_candidate"}});
    assert!(execute_refresh_job(&wrong_kind, root.path()).await.is_err());
}

#[tokio::test]
async fn overlapping_content_conflict_returns_the_precise_path() {
    let (root, base, head, _candidate) = history();
    // Rebuild the candidate directly from the reserved base on the overlapping path.
    git(root.path(), &["checkout", "candidate"]);
    git(root.path(), &["reset", "--hard", &base]);
    fs::write(root.path().join("shared.txt"), "candidate\n").unwrap();
    fs::write(
        root.path().join("candidate.txt"),
        "preserve this disjoint change\n",
    )
    .unwrap();
    git(root.path(), &["add", "candidate.txt"]);
    git(
        root.path(),
        &[
            "commit",
            "-am",
            "candidate overlap",
            "--author=Test <test@example.invalid>",
        ],
    );
    let candidate = git(root.path(), &["rev-parse", "HEAD"]);
    let result = refresh(
        root.path(),
        &base,
        &head,
        &candidate,
        "fork/repo",
        &["candidate.txt".into(), "shared.txt".into()],
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "unresolved");
    assert_eq!(result["conflict_paths"], json!(["shared.txt"]));
    let workspace = result["merge_workspace_commit"].as_str().unwrap();
    let parents = git(root.path(), &["show", "-s", "--format=%P", workspace]);
    assert_eq!(
        parents.split_whitespace().collect::<Vec<_>>(),
        vec![head.as_str(), candidate.as_str()]
    );
    let marker_content = git(
        root.path(),
        &[
            "show",
            &format!("{}:shared.txt", result["merge_tree"].as_str().unwrap()),
        ],
    );
    assert!(marker_content.contains("head\n"));
    assert!(marker_content.contains("candidate\n"));
    assert_eq!(
        git(
            root.path(),
            &[
                "show",
                &format!("{}:candidate.txt", result["merge_tree"].as_str().unwrap())
            ]
        ),
        "preserve this disjoint change"
    );
}
