//! `yoneda org …`: organizations on the account API. The platform decides who may do what
//! (owners manage members and teams); this prints what it answers.
use crate::api::encode;
use crate::command::OrgCommand;
use crate::error::Result;
use crate::human;
use crate::output::{self, OrgMember, OrgMembership, OrgRepo, OrgTeam};
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

/// A field for `--json` (empty when absent, where the human text shows `?`).
fn owned(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

fn show(org: &Value) {
    human!(
        "{}  (you: {}, created by {})",
        text(&org["org"]),
        text(&org["role"]),
        text(&org["created_by"])
    );
    human!("members:");
    for m in org["members"].as_array().into_iter().flatten() {
        human!("  {}  {}", text(&m["account"]), text(&m["role"]));
    }
    human!("teams:");
    for t in org["teams"].as_array().into_iter().flatten() {
        let members: Vec<&str> = t["members"]
            .as_array()
            .into_iter()
            .flatten()
            .map(text)
            .collect();
        human!("  {}  [{}]", text(&t["name"]), members.join(", "));
    }
    let list = |key: &str| org[key].as_array().cloned().unwrap_or_default();
    output::emit(&output::OrgShow {
        org: owned(&org["org"]),
        role: owned(&org["role"]),
        created_by: owned(&org["created_by"]),
        members: list("members")
            .iter()
            .map(|m| OrgMember {
                account: owned(&m["account"]),
                role: owned(&m["role"]),
            })
            .collect(),
        teams: list("teams")
            .iter()
            .map(|t| OrgTeam {
                name: owned(&t["name"]),
                members: t["members"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(owned)
                    .collect(),
            })
            .collect(),
    });
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
                human!("No organizations");
            }
            for o in &orgs {
                human!("{}  {}", text(&o["org"]), text(&o["role"]));
            }
            let orgs = orgs
                .iter()
                .map(|o| OrgMembership {
                    org: owned(&o["org"]),
                    role: owned(&o["role"]),
                })
                .collect();
            output::emit(&output::OrgList { orgs });
        }
        OrgCommand::Create { name } => {
            api.post("/orgs", &json!({ "name": name })).await?;
            human!("Created organization {name} (you are its owner)");
            output::emit(&output::OrgCreate { org: name });
        }
        OrgCommand::Show { org } => show(&api.get(&path(&org, &[])).await?),
        OrgCommand::Repos { org } => {
            let repos = api.get(&path(&org, &["repos"])).await?["repos"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if repos.is_empty() {
                human!("No repositories");
            }
            for r in &repos {
                human!("{}  {}", text(&r["id"]), text(&r["name"]));
            }
            let repos = repos
                .iter()
                .map(|r| OrgRepo {
                    id: owned(&r["id"]),
                    name: owned(&r["name"]),
                })
                .collect();
            output::emit(&output::OrgRepos { org, repos });
        }
        OrgCommand::Delete { org, confirm } => {
            let query = format!("?confirm={}", crate::api::encode(&confirm));
            api.delete(&format!("{}{query}", path(&org, &[]))).await?;
            human!("Deleted organization {org}; its name is retired");
            output::emit(&output::OrgDelete { org });
        }
        OrgCommand::MemberAdd { org, account, role } => {
            let body = json!({ "account": account, "role": role });
            api.post(&path(&org, &["members"]), &body).await?;
            human!("{account} is now {role} of {org}");
            output::emit(&output::OrgMemberAdd { org, account, role });
        }
        OrgCommand::MemberRemove { org, account } => {
            api.delete(&path(&org, &["members", &account])).await?;
            human!("Removed {account} from {org} (and its teams)");
            output::emit(&output::OrgMemberRemove { org, account });
        }
        OrgCommand::TeamCreate { org, team } => {
            api.post(&path(&org, &["teams"]), &json!({ "name": team }))
                .await?;
            human!("Created team {org}/{team}; grant it on a repository as team:{org}/{team}");
            output::emit(&output::OrgTeamCreate { org, team });
        }
        OrgCommand::TeamDelete { org, team } => {
            api.delete(&path(&org, &["teams", &team])).await?;
            human!("Deleted team {org}/{team}");
            output::emit(&output::OrgTeamDelete { org, team });
        }
        OrgCommand::TeamAdd { org, team, account } => {
            let body = json!({ "account": account });
            api.post(&path(&org, &["teams", &team, "members"]), &body)
                .await?;
            human!("Added {account} to {org}/{team}");
            output::emit(&output::OrgTeamAdd { org, team, account });
        }
        OrgCommand::TeamRemove { org, team, account } => {
            api.delete(&path(&org, &["teams", &team, "members", &account]))
                .await?;
            human!("Removed {account} from {org}/{team}");
            output::emit(&output::OrgTeamRemove { org, team, account });
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
