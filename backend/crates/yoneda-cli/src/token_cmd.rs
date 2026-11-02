//! `yoneda token`: a repository's tokens. A token's secret is shown once.
use crate::command::TokenCommand;
use crate::error::{Error, Result};
use crate::human;
use crate::output;
use crate::repo_ops::print;
use crate::target::Resolved;
use serde_json::json;

pub async fn token(t: &Resolved, command: TokenCommand) -> Result<()> {
    match command {
        TokenCommand::Create {
            name,
            scopes,
            paths,
        } => {
            let body = json!({ "name": name, "scopes": scopes, "paths": paths });
            let made = t.api.post("/tokens", &body).await?;
            let secret = made["token"]
                .as_str()
                .ok_or_else(|| Error::new("the platform returned no token"))?;
            eprintln!("Repository token {name} for {} (shown once):", t.repo);
            human!("{secret}");
            output::emit(&output::TokenCreate {
                repo: t.repo.clone(),
                token: secret.to_owned(),
                name,
            });
        }
        TokenCommand::List => {
            let listed = t.api.get("/tokens").await?;
            print(&listed);
            let tokens = listed["tokens"].as_array().cloned().unwrap_or_default();
            output::emit(&output::TokenList { tokens });
        }
        TokenCommand::Revoke { name } => {
            let done = t
                .api
                .delete(&format!("/tokens/{}", crate::api::encode(&name)))
                .await?;
            if done["revoked"] == false {
                return Err(Error::new(format!("{} has no live token {name}", t.repo)));
            }
            human!("Revoked {name}");
            output::emit(&output::TokenRevoke {
                repo: t.repo.clone(),
                name,
            });
        }
    }
    Ok(())
}
