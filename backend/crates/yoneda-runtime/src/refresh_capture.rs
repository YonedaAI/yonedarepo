//! Trusted Git transport for the reserved candidate-refresh capture subtype.
use crate::{err, git::git, git::git_raw, git_revision::fetch_git, transport};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;
use yoneda_core::Result;

const REVIEW_DIFF_LIMIT: usize = 24 * 1024 * 1024;

pub(crate) async fn execute(job: &Value, _work_root: &Path) -> Result<Value> {
    if crate::source_workspace_job::enabled(job) {
        return crate::source_refresh::execute(job).await;
    }
    if !transport::enabled(job) {
        return Err(err(
            "Refresh capture requires frozen git-native-v1 transport",
        ));
    }
    let payload = &job["payload"];
    let source = &payload["candidate"];
    let canonical = source["base"]["repository"]
        .as_str()
        .ok_or_else(|| err("Refresh job is missing its frozen canonical repository"))?;
    let candidate_repo = source["revision"]["repository"]
        .as_str()
        .ok_or_else(|| err("Refresh job is missing its frozen candidate repository"))?;
    let base = payload["expected_base"]
        .as_str()
        .ok_or_else(|| err("Refresh job is missing its frozen base"))?;
    let head = payload["expected_head"]
        .as_str()
        .ok_or_else(|| err("Refresh job is missing its frozen head"))?;
    let candidate = source["revision"]["commit"]
        .as_str()
        .ok_or_else(|| err("Refresh job is missing its frozen candidate revision"))?;
    let output_repo = job["fork"]
        .as_str()
        .ok_or_else(|| err("Refresh output fork was not provisioned"))?;

    let repository = tempfile::tempdir().map_err(err)?;
    git(repository.path(), &["init", "-b", "main"]).await?;
    fetch_git(
        repository.path(),
        "http://git.yoneda.internal/current",
        base,
    )
    .await?;
    fetch_git(repository.path(), "http://git.yoneda.internal/head", head).await?;
    fetch_git(
        repository.path(),
        "http://git.yoneda.internal/candidate",
        candidate,
    )
    .await?;

    let mut result = crate::conflict_merge::execute_refresh_job(job, repository.path()).await?;
    let pushed = if result["status"] == "clean" {
        result["merge_commit"]
            .as_str()
            .ok_or_else(|| err("Clean refresh omitted its merge commit"))?
    } else {
        result["merge_workspace_commit"]
            .as_str()
            .ok_or_else(|| err("Unresolved refresh omitted its merge workspace"))?
    }
    .to_owned();
    let diff = reviewable_diff(repository.path(), head, &pushed).await?;
    git(
        repository.path(),
        &[
            "push",
            &format!("--force-with-lease=refs/heads/main:{head}"),
            "http://git.yoneda.internal/fork",
            &format!("{pushed}:refs/heads/main"),
        ],
    )
    .await?;
    if result["status"] == "clean" {
        result["revision"] = json!({"repository":output_repo,"commit":pushed});
    } else {
        result["merge_workspace_revision"] = json!({"repository":output_repo,"commit":pushed});
    }
    result["diff"] = json!(diff);
    result["transport_receipt"] = json!({
        "repository":output_repo,
        "commit":pushed,
        "expected_head":head,
        "canonical_repository":canonical,
        "candidate_repository":candidate_repo,
        "tree":result["tree"],
    });
    Ok(result)
}

async fn reviewable_diff(root: &Path, head: &str, pushed: &str) -> Result<String> {
    let bytes = git_raw(
        root,
        &[
            "diff",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            head,
            pushed,
        ],
    )
    .await?;
    decode_review_diff(bytes)
}

fn decode_review_diff(bytes: Vec<u8>) -> Result<String> {
    if bytes.len() > REVIEW_DIFF_LIMIT {
        return Err(err("Refresh diff exceeds the 24 MiB review limit"));
    }
    String::from_utf8(bytes).map_err(|_| err("Refresh diff is not valid UTF-8"))
}

/// Return the resolver's edits relative to its frozen merge workspace. A
/// resolver may edit any valid path except protected verification paths
/// (`yoneda_core::resolver_scope`); the captured revision is still based on the
/// reserved head and receives fresh independent checks.
pub(crate) async fn resolver_capture_scope(
    job: &Value,
    output: &transport::GitWorkspace,
) -> Result<Vec<String>> {
    let resolver = &job["payload"]["conflict_resolver"];
    let commit = resolver["merge_workspace_commit"]
        .as_str()
        .ok_or_else(|| err("Resolver job is missing its frozen merge workspace"))?;
    let repository = resolver["merge_workspace_repository"]
        .as_str()
        .ok_or_else(|| err("Resolver job is missing its merge-workspace repository"))?;
    if repository.is_empty() {
        return Err(err("Invalid frozen merge-workspace repository"));
    }
    let merged =
        crate::git::read_git_revision("http://git.yoneda.internal/merge-workspace", commit).await?;
    resolver_delta(job, &merged, output)
}

fn resolver_delta(
    job: &Value,
    merged: &transport::GitWorkspace,
    output: &transport::GitWorkspace,
) -> Result<Vec<String>> {
    let protected = yoneda_core::resolver_scope::frozen_protected(&job["payload"])?;
    let delta: Vec<String> = changed_paths(merged, output).into_iter().collect();
    yoneda_core::resolver_scope::validate_edits(delta.iter().map(String::as_str), &protected)?;
    Ok(delta)
}

fn changed_paths(
    before: &transport::GitWorkspace,
    after: &transport::GitWorkspace,
) -> BTreeSet<String> {
    before
        .keys()
        .chain(after.keys())
        .filter(|path| match (before.get(*path), after.get(*path)) {
            (Some(left), Some(right)) => {
                left.bytes != right.bytes || left.executable != right.executable
            }
            _ => true,
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod resolver_scope_tests {
    #[tokio::test]
    async fn api_refresh_dispatches_to_sparse_attempt_validation_not_git_native() {
        let root = tempfile::tempdir().unwrap();
        let job = serde_json::json!({"kind":"capture","payload":{"workspace_transport":"api-source-v1","capture_subtype":"refresh_candidate"}});
        // Missing trusted attempt fields must fail before credentials or any transport request.
        let error = super::execute(&job, root.path()).await.unwrap_err();
        assert_eq!(error.code, "SOURCE_REFRESH");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
    use super::{REVIEW_DIFF_LIMIT, changed_paths, decode_review_diff, reviewable_diff};
    use crate::{
        capture, git,
        transport::{GitFile, GitWorkspace},
    };
    use yoneda_core::{FileEntry, Workspace};

    #[tokio::test]
    async fn refresh_diff_contains_the_full_patch_for_the_expected_head() {
        let root = tempfile::tempdir().unwrap();
        let base = capture(
            root.path(),
            None,
            &Workspace::from([(
                "src.txt".into(),
                FileEntry::from_bytes(b"old\n".to_vec(), false),
            )]),
            "approved head",
        )
        .await
        .unwrap();
        let head = base["commit"].as_str().unwrap();
        git(root.path(), &["config", "user.name", "review test"])
            .await
            .unwrap();
        git(
            root.path(),
            &["config", "user.email", "review@example.invalid"],
        )
        .await
        .unwrap();
        std::fs::write(root.path().join("src.txt"), "new\n").unwrap();
        git(root.path(), &["add", "src.txt"]).await.unwrap();
        git(root.path(), &["commit", "-m", "candidate"])
            .await
            .unwrap();
        let pushed = git(root.path(), &["rev-parse", "HEAD"]).await.unwrap();

        let diff = reviewable_diff(root.path(), head, &pushed).await.unwrap();
        assert!(diff.contains("diff --git a/src.txt b/src.txt"));
        assert!(diff.contains("-old\n+new\n"));
        assert!(!diff.contains("files changed"));
    }

    #[test]
    fn refresh_diff_rejects_oversized_and_non_utf8_payloads_instead_of_truncating() {
        assert!(decode_review_diff(vec![b'x'; REVIEW_DIFF_LIMIT + 1]).is_err());
        assert!(decode_review_diff(vec![0xff]).is_err());
    }

    #[test]
    fn head_relative_scope_includes_clean_merged_candidate_paths_and_resolver_delta_is_separate() {
        let head = GitWorkspace::from([("head.txt".into(), file(b"head"))]);
        let merge = GitWorkspace::from([
            ("head.txt".into(), file(b"head")),
            ("clean-candidate.txt".into(), file(b"kept")),
            ("conflict.txt".into(), file(b"marker")),
        ]);
        let resolved = GitWorkspace::from([
            ("head.txt".into(), file(b"head")),
            ("clean-candidate.txt".into(), file(b"kept")),
            ("conflict.txt".into(), file(b"resolved")),
        ]);
        assert_eq!(
            changed_paths(&head, &resolved),
            ["clean-candidate.txt", "conflict.txt"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        );
        assert_eq!(
            changed_paths(&merge, &resolved),
            ["conflict.txt"].into_iter().map(str::to_owned).collect()
        );
    }

    #[test]
    fn resolver_may_edit_any_unprotected_path_beyond_the_conflict_paths() {
        let merge = GitWorkspace::from([
            ("conflict.txt".into(), file(b"marker")),
            ("one-side.txt".into(), file(b"old")),
            ("README.md".into(), file(b"guide")),
        ]);
        let mut resolved = merge.clone();
        resolved.insert("conflict.txt".into(), file(b"resolved"));
        resolved.insert("one-side.txt".into(), file(b"wired"));
        resolved.insert("new.txt".into(), file(b"new"));
        let job = serde_json::json!({"payload":{"conflict_paths":["conflict.txt"],"resolver_protected_paths":["tests/oracle"]}});
        assert_eq!(
            super::resolver_delta(&job, &merge, &resolved).unwrap(),
            ["conflict.txt", "new.txt", "one-side.txt"]
        );
        for protected in ["README.md", "tests/oracle/run.mjs"] {
            let mut edited = resolved.clone();
            edited.insert(protected.into(), file(b"changed"));
            assert!(
                super::resolver_delta(&job, &merge, &edited).is_err(),
                "{protected}"
            );
        }
    }

    fn file(bytes: &[u8]) -> GitFile {
        GitFile {
            bytes: bytes.to_vec(),
            executable: false,
        }
    }
}
