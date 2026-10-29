//! `yoneda release`: releases of existing tags. `create` publishes one (and uploads one
//! asset with `--asset`), `list` and `show` read them; downloads are plain HTTPS GETs of
//! `/releases/<tag>/assets/<name>`, which answer the recorded sha256 in `x-yoneda-sha256`.
use crate::api::encode;
use crate::command::ReleaseCommand;
use crate::error::{Error, Result};
use crate::human;
use crate::output::{self, Asset, ReleaseSummary};
use crate::target::Resolved;
use serde_json::{Value, json};
use std::path::Path;

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

/// `v1 First release (abc1234) by user:ws, 2 asset(s)`
fn summary(release: &Value) -> String {
    let commit = text(release, "commit_id");
    format!(
        "{} {} ({}) by {}, {} asset(s)",
        text(release, "tag"),
        text(release, "title"),
        &commit[..commit.len().min(7)],
        text(release, "created_by"),
        release["asset_count"],
    )
}

/// The one-line fields of a release, for `--json`.
fn summarized(release: &Value) -> ReleaseSummary {
    ReleaseSummary {
        tag: text(release, "tag"),
        title: text(release, "title"),
        commit_id: text(release, "commit_id"),
        created_by: text(release, "created_by"),
        asset_count: release["asset_count"].as_u64().unwrap_or_default(),
    }
}

fn show(release: &Value) {
    human!("{}", summary(release));
    if let Some(message) = release["annotated"]["message"].as_str() {
        human!(
            "tag {}: {}",
            text(&release["annotated"], "id"),
            message.trim_end()
        );
    }
    if !text(release, "notes").is_empty() {
        human!("\n  {}\n", text(release, "notes").replace('\n', "\n  "));
    }
    for asset in release["assets"].as_array().into_iter().flatten() {
        human!(
            "  {} {} bytes sha256 {}",
            text(asset, "name"),
            asset["size"],
            text(asset, "sha256")
        );
    }
}

pub async fn run(t: &Resolved, command: ReleaseCommand) -> Result<()> {
    match command {
        ReleaseCommand::Create {
            tag,
            title,
            notes,
            asset,
        } => {
            let title = title.unwrap_or_else(|| tag.clone());
            let body = json!({ "tag": tag, "title": title, "notes": notes });
            let release = t.api.post("/releases", &body).await?;
            human!("Published {}", summary(&release));
            let mut report = output::ReleaseCreate {
                release: summarized(&release),
                asset: None,
            };
            if let Some(file) = asset {
                let path = Path::new(&file);
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| Error::usage(format!("{file} is not a file name")))?;
                let bytes = std::fs::read(path)
                    .map_err(|e| Error::new(format!("cannot read {file}: {e}")))?;
                let uploaded = t
                    .api
                    .put_bytes(
                        &format!("/releases/{}/assets/{}", encode(&tag), encode(name)),
                        bytes,
                        "application/octet-stream",
                    )
                    .await?;
                human!(
                    "Uploaded {} ({} bytes, sha256 {})",
                    text(&uploaded, "name"),
                    uploaded["size"],
                    text(&uploaded, "sha256")
                );
                report.asset = Some(Asset {
                    name: text(&uploaded, "name"),
                    size: uploaded["size"].as_u64().unwrap_or_default(),
                    sha256: text(&uploaded, "sha256"),
                });
            }
            output::emit(&report);
        }
        ReleaseCommand::List => {
            let listed = t.api.get("/releases").await?;
            let releases = listed["releases"].as_array().cloned().unwrap_or_default();
            if releases.is_empty() {
                human!("No releases");
            }
            for release in &releases {
                human!("{}", summary(release));
            }
            output::emit(&output::ReleaseList {
                releases: releases.iter().map(summarized).collect(),
            });
        }
        ReleaseCommand::Show { tag } => {
            let release = t.api.get(&format!("/releases/{}", encode(&tag))).await?;
            show(&release);
            output::emit(&output::ReleaseShow { release });
        }
    }
    Ok(())
}
