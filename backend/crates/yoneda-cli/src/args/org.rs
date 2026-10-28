//! `yoneda org …`: organizations, their members and teams (account-level, like `repo`).
use super::parser::{Parsed, split_sub};
use crate::command::{Command, OrgCommand};
use crate::error::{Error, Result};

pub fn org(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "org")?;
    match sub.as_str() {
        "member" => return member(&rest),
        "team" => return team(&rest),
        _ => {}
    }
    let p = Parsed::new(&rest, &["origin"], &[])?;
    let one = |what: &str| Ok::<_, Error>(p.exactly(1, what)?[0].clone());
    let command = match sub.as_str() {
        "list" => {
            p.at_most(0)?;
            OrgCommand::List
        }
        "create" => OrgCommand::Create {
            name: one("org create <name>")?,
        },
        "show" => OrgCommand::Show {
            org: one("org show <org>")?,
        },
        "repos" => OrgCommand::Repos {
            org: one("org repos <org>")?,
        },
        other => return Err(Error::usage(format!("unknown org command {other:?}"))),
    };
    Ok(Command::Org {
        origin: p.flag("origin"),
        command,
    })
}

/// `org member add <org> <account> [--role owner|member]` | `org member remove <org> <account>`.
fn member(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "org member")?;
    let p = Parsed::new(&rest, &["origin", "role"], &[])?;
    let command = match sub.as_str() {
        "add" => {
            let [org, account] = p.exactly(2, "org member add <org> <account>")? else {
                return Err(Error::usage("expected org member add <org> <account>"));
            };
            let role = p.flag("role").unwrap_or_else(|| "member".into());
            if !["owner", "member"].contains(&role.as_str()) {
                return Err(Error::usage("--role must be owner or member"));
            }
            OrgCommand::MemberAdd {
                org: org.clone(),
                account: account.clone(),
                role,
            }
        }
        "remove" if p.flag("role").is_none() => {
            let [org, account] = p.exactly(2, "org member remove <org> <account>")? else {
                return Err(Error::usage("expected org member remove <org> <account>"));
            };
            OrgCommand::MemberRemove {
                org: org.clone(),
                account: account.clone(),
            }
        }
        "remove" => return Err(Error::usage("org member remove takes no --role")),
        other => {
            return Err(Error::usage(format!(
                "unknown org member command {other:?}"
            )));
        }
    };
    Ok(Command::Org {
        origin: p.flag("origin"),
        command,
    })
}

/// `org team create|delete <org> <team>` | `org team add|remove <org> <team> <account>`.
fn team(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "org team")?;
    let p = Parsed::new(&rest, &["origin"], &[])?;
    let command = match sub.as_str() {
        "create" | "delete" => {
            let [org, team] = p.exactly(2, &format!("org team {sub} <org> <team>"))? else {
                return Err(Error::usage(format!(
                    "expected org team {sub} <org> <team>"
                )));
            };
            let (org, team) = (org.clone(), team.clone());
            if sub == "create" {
                OrgCommand::TeamCreate { org, team }
            } else {
                OrgCommand::TeamDelete { org, team }
            }
        }
        "add" | "remove" => {
            let what = format!("org team {sub} <org> <team> <account>");
            let [org, team, account] = p.exactly(3, &what)? else {
                return Err(Error::usage(format!("expected {what}")));
            };
            let (org, team, account) = (org.clone(), team.clone(), account.clone());
            if sub == "add" {
                OrgCommand::TeamAdd { org, team, account }
            } else {
                OrgCommand::TeamRemove { org, team, account }
            }
        }
        other => return Err(Error::usage(format!("unknown org team command {other:?}"))),
    };
    Ok(Command::Org {
        origin: p.flag("origin"),
        command,
    })
}
