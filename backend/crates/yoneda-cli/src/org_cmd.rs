//! `yoneda org …`: organizations on the account API. The platform decides who may do what
//! (owners manage members and teams); this prints what it answers.
use crate::api::encode;
use crate::command::OrgCommand;
use crate::error::Result;
use crate::target;
use serde_json::{Value, json};

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("?")
}

/// The `/orgs/<org>` path, with each later segment encoded.
fn path(org: &str, rest: &[&str]) -> String {
    std::iter::once(format!("/orgs/{}", encode(org)))
        .chain(rest.iter().map(|s| format!("/{}", encode(s))))
        .collect()
}

fn show(org: &Value) {
    println!(
        "{}  (you: {}, created by {})",
        text(&org["org"]),
        text(&org["role"]),
        text(&org["created_by"])
    );
    println!("members:");
    for m in org["members"].as_array().into_iter().flatten() {
        println!("  {}  {}", text(&m["account"]), text(&m["role"]));
    }
    println!("teams:");
    for t in org["teams"].as_array().into_iter().flatten() {
        let members: Vec<&str> = t["members"]
            .as_array()
            .into_iter()
            .flatten()
            .map(text)
            .collect();
        println!("  {}  [{}]", text(&t["name"]), members.join(", "));
    }
}

pub async fn run(origin: Option<&str>, command: OrgCommand) -> Result<()> {
    let (_, api) = target::account_api(origin)?;
    match command {
        OrgCommand::List => {
            let orgs = api.get("/orgs").await?["orgs"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if orgs.is_empty() {
                println!("No organizations");
            }
            for o in orgs {
                println!("{}  {}", text(&o["org"]), text(&o["role"]));
            }
        }
        OrgCommand::Create { name } => {
            api.post("/orgs", &json!({ "name": name })).await?;
            println!("Created organization {name} (you are its owner)");
        }
        OrgCommand::Show { org } => show(&api.get(&path(&org, &[])).await?),
        OrgCommand::Repos { org } => {
            let repos = api.get(&path(&org, &["repos"])).await?["repos"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if repos.is_empty() {
                println!("No repositories");
            }
            for r in repos {
                println!("{}  {}", text(&r["id"]), text(&r["name"]));
            }
        }
        OrgCommand::MemberAdd { org, account, role } => {
            let body = json!({ "account": account, "role": role });
            api.post(&path(&org, &["members"]), &body).await?;
            println!("{account} is now {role} of {org}");
        }
        OrgCommand::MemberRemove { org, account } => {
            api.delete(&path(&org, &["members", &account])).await?;
            println!("Removed {account} from {org} (and its teams)");
        }
        OrgCommand::TeamCreate { org, team } => {
            api.post(&path(&org, &["teams"]), &json!({ "name": team }))
                .await?;
            println!("Created team {org}/{team}; grant it on a repository as team:{org}/{team}");
        }
        OrgCommand::TeamDelete { org, team } => {
            api.delete(&path(&org, &["teams", &team])).await?;
            println!("Deleted team {org}/{team}");
        }
        OrgCommand::TeamAdd { org, team, account } => {
            let body = json!({ "account": account });
            api.post(&path(&org, &["teams", &team, "members"]), &body)
                .await?;
            println!("Added {account} to {org}/{team}");
        }
        OrgCommand::TeamRemove { org, team, account } => {
            api.delete(&path(&org, &["teams", &team, "members", &account]))
                .await?;
            println!("Removed {account} from {org}/{team}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn org_paths_encode_each_segment() {
        assert_eq!(super::path("acme", &[]), "/orgs/acme");
        assert_eq!(
            super::path("acme", &["teams", "devs", "members", "a@b.co"]),
            format!(
                "/orgs/acme/teams/devs/members/{}",
                crate::api::encode("a@b.co")
            )
        );
    }
}
