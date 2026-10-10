//! Trusted Git transport for the reserved candidate-refresh capture subtype.
use crate::{err, git::git, git_revision::fetch_git, transport};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;
use yoneda_core::Result;

pub(crate) async fn execute(job: &Value, _work_root: &Path) -> Result<Value> {
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

/// Validate the resolver result against the expected head while permitting the
/// clean, owner-approved candidate paths already present in its merge baseline.
pub(crate) async fn resolver_capture_scope(
    job: &Value,
    output: &transport::GitWorkspace,
) -> Result<(transport::GitWorkspace, Value, Vec<String>)> {
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
    let base = job["payload"]["execution"]["base"]["commit"]
        .as_str()
        .ok_or_else(|| err("Resolver job is missing its expected canonical head"))?;
    let head = crate::git::read_git_revision("http://git.yoneda.internal/canonical", base).await?;
    let merged =
        crate::git::read_git_revision("http://git.yoneda.internal/merge-workspace", commit).await?;
    let mut allowed = changed_paths(&head, &merged);
    let conflict_paths = job["payload"]["team_owned_paths"]
        .as_array()
        .ok_or_else(|| err("Resolver job is missing its approved conflict paths"))?;
    for path in conflict_paths {
        let path = path
            .as_str()
            .ok_or_else(|| err("Invalid approved conflict path"))?;
        yoneda_core::validate_path(path)?;
        allowed.insert(path.to_owned());
    }
    let delta = changed_paths(&merged, output).into_iter().collect();
    Ok((head, json!(allowed.into_iter().collect::<Vec<_>>()), delta))
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
    use super::changed_paths;
    use crate::transport::{GitFile, GitWorkspace};

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

    fn file(bytes: &[u8]) -> GitFile {
        GitFile {
            bytes: bytes.to_vec(),
            executable: false,
        }
    }
}
