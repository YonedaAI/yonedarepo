//! Study source moves only through the remote MCP attempt tools and the owner's platform
//! session: the base is read with `attempt_read`, a trial's files are committed with
//! `attempt_commit`, and a fixture is published by the owner's own platform landing.
use super::client::Client;
use crate::process::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_agents_core::{FileEntry, Workspace};

/// Per-call budget for `attempt_commit`, below the MCP request limit.
const COMMIT_BYTES: usize = 3 * 1024 * 1024;

pub(super) struct Attempt<'a> {
    pub client: &'a Client,
    pub repo: &'a str,
    pub grant: &'a str,
    pub session: &'a str,
    pub id: &'a str,
}

impl Attempt<'_> {
    async fn tool(&self, name: &str, mut args: Value) -> Result<Value> {
        args["attempt_id"] = json!(self.id);
        self.client
            .mcp(self.repo, self.grant, Some(self.session), name, args)
            .await
    }

    /// Every regular file of the attempt's current source.
    pub async fn read(&self) -> Result<Workspace> {
        let mut files = Workspace::new();
        let mut directories = vec![String::new()];
        while let Some(directory) = directories.pop() {
            let listed = self
                .tool("attempt_read", json!({"path": directory}))
                .await?;
            for entry in listed["entries"]
                .as_array()
                .ok_or("Invalid source listing")?
            {
                let name = entry["name"].as_str().ok_or("Invalid source entry")?;
                let path = if directory.is_empty() {
                    name.to_owned()
                } else {
                    format!("{directory}/{name}")
                };
                match entry["type"].as_str() {
                    Some("tree") => directories.push(path),
                    Some(kind @ ("blob" | "exec")) => {
                        let file = self.tool("attempt_read", json!({"path": path})).await?;
                        let content = file["content"].as_str().ok_or("Invalid source file")?;
                        let bytes = if file["encoding"] == "base64" {
                            STANDARD.decode(content)?
                        } else {
                            content.as_bytes().to_vec()
                        };
                        files.insert(path, FileEntry::from_bytes(bytes, kind == "exec"));
                    }
                    _ => return Err("Study sources contain only regular files".into()),
                }
            }
        }
        Ok(files)
    }

    /// Commit `files` as the attempt's complete source, replacing `base`.
    pub async fn commit(&self, base: &Workspace, files: &Workspace, message: &str) -> Result<()> {
        let mut changes = Vec::new();
        for (path, file) in files {
            let bytes = file.bytes()?;
            if base.get(path).is_some_and(|old| {
                old.executable == file.executable && old.bytes().is_ok_and(|b| b == bytes)
            }) {
                continue;
            }
            changes.push(json!({"path": path, "content_b64": STANDARD.encode(&bytes),
                "executable": file.executable}));
        }
        for path in base.keys().filter(|path| !files.contains_key(*path)) {
            changes.push(json!({"path": path, "delete": true}));
        }
        if changes.is_empty() {
            return Err("The study produced no source change".into());
        }
        let mut batch = Vec::new();
        let mut size = 0;
        for change in changes {
            let bytes = change.to_string().len();
            if !batch.is_empty() && (size + bytes > COMMIT_BYTES || batch.len() == 500) {
                let changes = std::mem::take(&mut batch);
                self.tool(
                    "attempt_commit",
                    json!({"changes": changes, "message": message}),
                )
                .await?;
                size = 0;
            }
            size += bytes;
            batch.push(change);
        }
        self.tool(
            "attempt_commit",
            json!({"changes": batch, "message": message}),
        )
        .await?;
        Ok(())
    }
}

/// Publish a reserved decision as its owner: approve and land on the project's platform
/// repository with the study account's own session, then record the platform readback.
pub(super) async fn publish(client: &Client, repo: &str, receipt: &Value) -> Result<()> {
    let landing = &receipt["publication"];
    let platform = landing["platform_repo"]
        .as_str()
        .ok_or("Decision has no platform landing")?;
    let commit = landing["commit"].as_str().ok_or("Decision has no commit")?;
    let reviewed = client
        .api(
            &format!("v1/repos/{platform}/commits/{commit}/reviews"),
            Some(json!({"decision":"approve"})),
        )
        .await;
    if let Err(error) = reviewed
        && !error.to_string().contains("ALREADY_EXISTS")
    {
        return Err(error);
    }
    client
        .api(
            &format!("v1/repos/{platform}/land"),
            Some(json!({"ref":"main","commit":commit,"fast_forward_only":true})),
        )
        .await?;
    client
        .api(
            &format!("repos/{repo}/publication_readback"),
            Some(json!({"decision_id": receipt["id"]})),
        )
        .await?;
    Ok(())
}
