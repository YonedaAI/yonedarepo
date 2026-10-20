use crate::{
    broker::broker,
    err, field,
    git::{capture_fresh, git},
    workspace::materialize,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use yoneda_agents_core::{Result, Workspace};
pub(crate) async fn workspace(job: &Value, root: &Path) -> Result<Workspace> {
    let files = crate::team_source::load(job).await?;
    materialize(root, &files)?;
    Ok(files)
}

pub(crate) async fn execute_job(
    job: &Value,
    transcript: &crate::agent_transcript::Transcript,
) -> Result<Value> {
    let root = PathBuf::from("/work/repo");
    std::fs::create_dir_all(&root).map_err(err)?;
    match field(job, "kind")? {
        "agent"
            if job["payload"]["review_only"] == true
                || job["payload"]["comparison_review"] == true
                || job["payload"]["execution"]["comparison_role"] == "reviewer" =>
        {
            crate::comparison_review::execute(job, &root, transcript).await
        }
        "agent" => crate::agent::execute(job, &root, transcript).await,
        "capture" => {
            if job["payload"]["capture_subtype"] == "source_changeset" {
                return crate::source_capture::execute(job).await;
            }
            if job["payload"]["capture_subtype"] == "refresh_candidate" {
                if !crate::source_workspace_job::enabled(job) {
                    return Err(err("Refresh capture requires a lazy-source job"));
                }
                return crate::source_refresh::execute(job).await;
            }
            let data = broker("/workspace", json!({}), true).await?;
            let files: Workspace = serde_json::from_value(data["files"].clone()).map_err(err)?;
            let files = crate::transport::from_legacy(files)?;
            if let Some(scope) = job["payload"].get("team_owned_paths") {
                let before = crate::team_source::load_git(job).await?;
                crate::team_workspace::validate_changes_git(&before, &files, scope)?;
            }
            let base = job["payload"]["execution"]["base"]["commit"]
                .as_str()
                .or_else(|| job["payload"]["base"]["commit"].as_str())
                .ok_or_else(|| err("Frozen approved base commit is missing"))?;
            let mut result = capture_fresh(
                &root,
                "http://git.yoneda.internal/canonical",
                base,
                &files,
                "YonedaRepo captured candidate",
            )
            .await?;
            git(
                &root,
                &[
                    "push",
                    "http://git.yoneda.internal/candidate",
                    "HEAD:refs/heads/main",
                ],
            )
            .await?;
            result["id"] = json!(format!("candidate:{}:{}", field(job, "id")?, job["epoch"]));
            result["revision"] = json!({"repository":job["fork"],"commit":result["commit"]});
            result["summary"] = json!(format!(
                "{} approach",
                job["payload"]["execution"]["strategy"]
                    .as_str()
                    .unwrap_or("Candidate")
            ));
            if let Some(digest) = job["payload"].get("integration_digest") {
                result["integration_digest"] = digest.clone();
            }
            Ok(result)
        }
        "evaluate" => crate::evaluation::execute(job, &root).await,
        "publish" => {
            git(&root, &["init", "-b", "main"]).await?;
            let branch = job["payload"]["canonical"]["branch"]
                .as_str()
                .unwrap_or("main");
            git(&root, &["check-ref-format", "--branch", branch]).await?;
            let reference = format!("refs/heads/{branch}");
            let target = field(&job["payload"]["target"], "commit")?;
            let expected = field(&job["payload"]["expected"], "commit")?;
            git(
                &root,
                &["fetch", "http://git.yoneda.internal/candidate", target],
            )
            .await?;
            git(
                &root,
                &["fetch", "http://git.yoneda.internal/canonical", branch],
            )
            .await?;
            let observed = git(&root, &["rev-parse", "FETCH_HEAD"]).await?;
            if observed == target {
                return Ok(json!({"commit":target,"recovered":true}));
            }
            if observed != expected {
                return Ok(json!({"conflict":true,"observed":observed}));
            }
            git(&root, &["merge-base", "--is-ancestor", expected, target]).await?;
            git(
                &root,
                &[
                    "push",
                    &format!("--force-with-lease={reference}:{expected}"),
                    "http://git.yoneda.internal/canonical",
                    &format!("{target}:{reference}"),
                ],
            )
            .await?;
            let result = git(
                &root,
                &[
                    "ls-remote",
                    "http://git.yoneda.internal/canonical",
                    &reference,
                ],
            )
            .await?;
            if result.split_whitespace().next() != Some(target) {
                return Err(err("Publication readback did not match selected commit"));
            }
            Ok(json!({"commit":target}))
        }
        _ => Err(err("Unknown job kind")),
    }
}
