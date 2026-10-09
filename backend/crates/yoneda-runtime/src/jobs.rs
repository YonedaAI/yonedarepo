use crate::{
    broker::broker,
    err, field,
    git::{capture, git},
    workspace::materialize,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use yoneda_core::{Result, Workspace};
pub(crate) async fn workspace(job: &Value, root: &Path) -> Result<Workspace> {
    let result = broker("/source", json!({}), true).await?;
    let files: Workspace = serde_json::from_value(result["files"].clone()).map_err(err)?;
    materialize(root, &files)?;
    let _ = job;
    Ok(files)
}

pub(crate) async fn execute_job(job: &Value) -> Result<Value> {
    let root = PathBuf::from("/work/repo");
    std::fs::create_dir_all(&root).map_err(err)?;
    match field(job, "kind")? {
        "agent" => crate::agent::execute(job, &root).await,
        "capture" => {
            let data = broker("/workspace", json!({}), true).await?;
            let files: Workspace = serde_json::from_value(data["files"].clone()).map_err(err)?;
            git(&root, &["init", "-b", "main"]).await?;
            git(
                &root,
                &[
                    "fetch",
                    "http://git.yoneda.internal/canonical",
                    field(&job["payload"]["base"], "commit")?,
                ],
            )
            .await?;
            let mut result = capture(
                &root,
                Some(field(&job["payload"]["base"], "commit")?),
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
