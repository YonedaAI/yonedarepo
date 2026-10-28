//! `yoneda release`: releases of existing tags. `create` publishes one (and uploads one
//! asset with `--asset`), `list` and `show` read them; downloads are plain HTTPS GETs of
//! `/releases/<tag>/assets/<name>`, which answer the recorded sha256 in `x-yoneda-sha256`.
use crate::api::encode;
use crate::command::ReleaseCommand;
use crate::error::{Error, Result};
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

fn show(release: &Value) {
    println!("{}", summary(release));
    if let Some(message) = release["annotated"]["message"].as_str() {
        println!(
            "tag {}: {}",
            text(&release["annotated"], "id"),
            message.trim_end()
        );
    }
    if !text(release, "notes").is_empty() {
        println!("\n  {}\n", text(release, "notes").replace('\n', "\n  "));
    }
    for asset in release["assets"].as_array().into_iter().flatten() {
        println!(
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
            println!("Published {}", summary(&release));
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
                println!(
                    "Uploaded {} ({} bytes, sha256 {})",
                    text(&uploaded, "name"),
                    uploaded["size"],
                    text(&uploaded, "sha256")
                );
            }
        }
        ReleaseCommand::List => {
            let listed = t.api.get("/releases").await?;
            let releases = listed["releases"].as_array().cloned().unwrap_or_default();
            if releases.is_empty() {
                println!("No releases");
            }
            for release in &releases {
                println!("{}", summary(release));
            }
        }
        ReleaseCommand::Show { tag } => {
            show(&t.api.get(&format!("/releases/{}", encode(&tag))).await?)
        }
    }
    Ok(())
}
