//! `yoneda repo create|list|delete|import|fork|visibility`: repositories on the caller's
//! account (or, with `--owner`, on an organization it owns).
use crate::command::RepoCommand;
use crate::error::{Error, Result};
use crate::remote::url::RemoteUrl;
use crate::target;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::LazyLock;

/// Repositories made from the CLI land without reviews or checks (owner decision); the
/// policy can be tightened later with `yoneda policy set`.
pub static SOLO_POLICY: LazyLock<Value> =
    LazyLock::new(|| json!({ "approvals": 0, "required_checks": [] }));

fn clone_hint(origin: &str, repo: &str) -> String {
    let url = RemoteUrl {
        origin: origin.to_owned(),
        repo: repo.to_owned(),
    };
    format!("git clone {}", url.git_url())
}

pub async fn run(origin: Option<&str>, command: RepoCommand) -> Result<()> {
    let (origin, api) = target::account_api(origin)?;
    match command {
        RepoCommand::Create {
            name,
            owner,
            public,
        } => {
            let visibility = if public { "public" } else { "private" };
            let mut body =
                json!({ "name": name, "policy": *SOLO_POLICY, "visibility": visibility });
            if let Some(owner) = &owner {
                body["owner"] = json!(owner);
            }
            let created = api.post("/repos", &body).await?;
            let id = created["id"]
                .as_str()
                .ok_or_else(|| Error::new("the platform returned no repository id"))?;
            println!(
                "Created {visibility} {name} ({id})\n  {}",
                clone_hint(&origin, id)
            );
        }
        RepoCommand::List => {
            let listed = api.get("/repos").await?;
            let repos = listed["repos"].as_array().cloned().unwrap_or_default();
            if repos.is_empty() {
                println!("No repositories");
            }
            for repo in repos {
                println!(
                    "{}  {}  {}  {}",
                    repo["id"].as_str().unwrap_or("?"),
                    repo["name"].as_str().unwrap_or(""),
                    repo["visibility"].as_str().unwrap_or("private"),
                    repo["created_at"]
                );
            }
        }
        RepoCommand::Visibility { id, public } => {
            if !crate::api::valid_repo_id(&id) {
                return Err(Error::usage(format!("{id:?} is not a repository id")));
            }
            let visibility = if public { "public" } else { "private" };
            api.put(
                &format!("/repos/{id}/visibility"),
                &json!({ "visibility": visibility }),
            )
            .await?;
            println!("{id} is now {visibility}");
        }
        RepoCommand::Delete { id, confirm } => {
            let path = format!("/repos/{id}?confirm={}", crate::api::encode(&confirm));
            api.delete(&path).await?;
            println!("Deleted {id} ({confirm})");
        }
        RepoCommand::Import {
            dir,
            name,
            batch_files,
        } => {
            let dir = Path::new(&dir);
            let name = match name {
                Some(name) => name,
                None => std::fs::canonicalize(dir)
                    .ok()
                    .and_then(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_owned))
                    .ok_or_else(|| Error::usage("name the repository with --name"))?,
            };
            let token = target::token_for(&origin)?;
            let id = crate::import::import(&origin, &api, &token, dir, &name, batch_files).await?;
            println!("  {}", clone_hint(&origin, &id));
        }
        RepoCommand::Fork { id, name, owner } => {
            if !crate::api::valid_repo_id(&id) {
                return Err(Error::usage(format!("{id:?} is not a repository id")));
            }
            let forked = api
                .post(
                    &format!("/repos/{id}/fork"),
                    &json!({ "name": name, "owner": owner }),
                )
                .await?;
            let fork = forked["id"]
                .as_str()
                .ok_or_else(|| Error::new("the platform returned no repository id"))?;
            println!(
                "Forked {id} at version {} as {} ({fork}): {} ref(s), {} commit(s)\n  {}",
                forked["parent_version"],
                forked["name"].as_str().unwrap_or_default(),
                forked["refs"],
                forked["commits"],
                clone_hint(&origin, fork)
            );
            println!("next: push a branch, then yoneda change create <branch> --to-parent");
        }
    }
    Ok(())
}
