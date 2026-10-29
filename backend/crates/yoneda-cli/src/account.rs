//! `yoneda repo create|list|delete|import|fork|visibility`: repositories on the caller's
//! account (or, with `--owner`, on an organization it owns).
use crate::command::RepoCommand;
use crate::error::{Error, Result};
use crate::human;
use crate::output::{self, RepoListed, Visibility};
use crate::remote::url::RemoteUrl;
use crate::target;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::LazyLock;

/// Repositories made from the CLI land without reviews or checks (owner decision); the
/// policy can be tightened later with `yoneda policy set`.
pub static SOLO_POLICY: LazyLock<Value> =
    LazyLock::new(|| json!({ "approvals": 0, "required_checks": [] }));

fn remote(origin: &str, repo: &str) -> String {
    RemoteUrl {
        origin: origin.to_owned(),
        repo: repo.to_owned(),
    }
    .git_url()
}

fn clone_hint(origin: &str, repo: &str) -> String {
    format!("git clone {}", remote(origin, repo))
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

pub async fn run(origin: Option<&str>, command: RepoCommand) -> Result<()> {
    let (origin, api) = target::account_api(origin)?;
    match command {
        RepoCommand::Create {
            name,
            owner,
            public,
        } => {
            let visibility = Visibility::of(public).name();
            let mut body =
                json!({ "name": name, "policy": *SOLO_POLICY, "visibility": visibility });
            if let Some(owner) = &owner {
                body["owner"] = json!(owner);
            }
            let created = api.post("/repos", &body).await?;
            let id = created["id"]
                .as_str()
                .ok_or_else(|| Error::new("the platform returned no repository id"))?;
            human!(
                "Created {visibility} {name} ({id})\n  {}",
                clone_hint(&origin, id)
            );
            output::emit(&output::RepoCreate {
                id: id.to_owned(),
                name,
                visibility: Visibility::of(public),
                owner,
                remote: remote(&origin, id),
            });
        }
        RepoCommand::List => {
            let listed = api.get("/repos").await?;
            let repos = listed["repos"].as_array().cloned().unwrap_or_default();
            if repos.is_empty() {
                human!("No repositories");
            }
            for repo in &repos {
                human!(
                    "{}  {}  {}  {}",
                    repo["id"].as_str().unwrap_or("?"),
                    repo["name"].as_str().unwrap_or(""),
                    repo["visibility"].as_str().unwrap_or("private"),
                    repo["created_at"]
                );
            }
            let repos = repos
                .iter()
                .map(|repo| RepoListed {
                    id: text(&repo["id"]),
                    name: text(&repo["name"]),
                    visibility: repo["visibility"].as_str().unwrap_or("private").to_owned(),
                    created_at: repo["created_at"].clone(),
                })
                .collect();
            output::emit(&output::RepoList { repos });
        }
        RepoCommand::Visibility { id, public } => {
            if !crate::api::valid_repo_id(&id) {
                return Err(Error::usage(format!("{id:?} is not a repository id")));
            }
            let visibility = Visibility::of(public);
            api.put(
                &format!("/repos/{id}/visibility"),
                &json!({ "visibility": visibility.name() }),
            )
            .await?;
            human!("{id} is now {}", visibility.name());
            output::emit(&output::RepoVisibility { id, visibility });
        }
        RepoCommand::Delete { id, confirm } => {
            let path = format!("/repos/{id}?confirm={}", crate::api::encode(&confirm));
            api.delete(&path).await?;
            human!("Deleted {id} ({confirm})");
            output::emit(&output::RepoDelete { id, name: confirm });
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
            let (id, files) =
                crate::import::import(&origin, &api, &token, dir, &name, batch_files).await?;
            human!("  {}", clone_hint(&origin, &id));
            output::emit(&output::RepoImport {
                remote: remote(&origin, &id),
                id,
                name,
                files: files as u64,
            });
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
            human!(
                "Forked {id} at version {} as {} ({fork}): {} ref(s), {} commit(s)\n  {}",
                forked["parent_version"],
                forked["name"].as_str().unwrap_or_default(),
                forked["refs"],
                forked["commits"],
                clone_hint(&origin, fork)
            );
            human!("next: push a branch, then yoneda change create <branch> --to-parent");
            output::emit(&output::RepoFork {
                id: fork.to_owned(),
                name: text(&forked["name"]),
                parent_version: forked["parent_version"].as_u64(),
                refs: forked["refs"].as_u64(),
                commits: forked["commits"].as_u64(),
                remote: remote(&origin, fork),
                parent: id,
            });
        }
    }
    Ok(())
}
