//! Command-line parsing: a small table-driven parser (no framework). The command set is
//! wide but each command has a handful of flags; clap would add more than it removes.
#[cfg(test)]
mod docs;
mod org;
mod parser;
mod sub;

pub use crate::command::*;
use crate::error::{Error, Result};
use parser::{Parsed, with};

fn simple(rest: &[String], switches: &[&str]) -> Result<Parsed> {
    let p = Parsed::new(rest, &["origin"], switches)?;
    p.at_most(0)?;
    Ok(p)
}

fn setup(rest: &[String]) -> Result<Command> {
    let p = Parsed::new(rest, &["origin"], &[])?;
    let agent = match p.exactly(1, "setup claude|codex|gemini")?[0].as_str() {
        "claude" => Agent::Claude,
        "codex" => Agent::Codex,
        "gemini" => Agent::Gemini,
        other => return Err(Error::usage(format!("unknown agent {other:?}"))),
    };
    Ok(Command::Setup {
        agent,
        origin: p.flag("origin"),
    })
}

fn review(rest: &[String]) -> Result<Command> {
    let p = Parsed::new(rest, &with(&["message"]), &[])?;
    let [decision, commit] = p.exactly(2, "review approve|reject <sha>")? else {
        return Err(Error::usage("expected review approve|reject <sha>"));
    };
    let approve = match decision.as_str() {
        "approve" => true,
        "reject" => false,
        other => return Err(Error::usage(format!("unknown decision {other:?}"))),
    };
    Ok(Command::Review {
        target: p.target(),
        approve,
        commit: commit.clone(),
        reason: p.flag("message"),
    })
}

fn policy(rest: &[String]) -> Result<Command> {
    let p = Parsed::new(rest, &with(&[]), &[])?;
    let set = match p.positional.first().map(String::as_str) {
        Some("show") => {
            p.at_most(1)?;
            None
        }
        Some("set") => Some(p.exactly(2, "policy set '<json>'")?[1].clone()),
        _ => return Err(Error::usage("expected policy show | policy set '<json>'")),
    };
    Ok(Command::Policy {
        target: p.target(),
        set,
    })
}

fn clone(rest: &[String]) -> Result<Command> {
    let p = Parsed::new(rest, &["origin"], &[])?;
    p.at_most(2)?;
    let repo = p
        .positional
        .first()
        .cloned()
        .ok_or_else(|| Error::usage("clone needs a repository id"))?;
    Ok(Command::Clone {
        repo,
        dir: p.positional.get(1).cloned(),
        origin: p.flag("origin"),
    })
}

pub fn parse(args: &[String]) -> Result<Command> {
    let Some((command, rest)) = args.split_first() else {
        return Ok(Command::Help);
    };
    Ok(match command.as_str() {
        "login" => {
            let p = simple(rest, &["with-token", "no-browser"])?;
            Command::Login {
                origin: p.flag("origin"),
                with_token: p.on("with-token"),
                browser: !p.on("no-browser"),
            }
        }
        "logout" => Command::Logout {
            origin: simple(rest, &[])?.flag("origin"),
        },
        "repo" => sub::repo(rest)?,
        "org" => org::org(rest)?,
        "token" => sub::token(rest)?,
        "check" => sub::check(rest)?,
        "log" | "grep" | "blame" | "diff" | "symbols" => sub::read(command, rest)?,
        "setup" => setup(rest)?,
        "land" => {
            let p = Parsed::new(rest, &with(&["branch"]), &[])?;
            p.at_most(0)?;
            Command::Land {
                target: p.target(),
                branch: p.flag("branch"),
            }
        }
        "rebase" => {
            let p = Parsed::new(rest, &with(&["onto"]), &[])?;
            let branch = p.exactly(1, "rebase <branch> [--onto <b>]")?[0].clone();
            Command::Rebase {
                target: p.target(),
                branch,
                onto: p.flag("onto"),
            }
        }
        "review" => review(rest)?,
        "policy" => policy(rest)?,
        "conflicts" => {
            Parsed::new(rest, &[], &[])?.at_most(0)?;
            Command::Conflicts
        }
        "clone" => clone(rest)?,
        "status" => {
            let p = Parsed::new(rest, &[], &["brief"])?;
            p.at_most(0)?;
            Command::Status {
                brief: p.on("brief"),
            }
        }
        "pull" => {
            Parsed::new(rest, &[], &[])?.at_most(0)?;
            Command::Pull
        }
        "sync" => sub::sync(rest)?,
        "reads" => sub::declared_reads(rest)?,
        "push" => Command::Push(rest.to_vec()),
        "session" => sub::session(rest)?,
        "change" => sub::change(rest)?,
        "release" => sub::release(rest)?,
        "hook" => sub::hook(rest)?,
        "help" | "--help" | "-h" => Command::Help,
        other => {
            return Err(Error::usage(format!(
                "unknown command {other:?}\n\n{USAGE}"
            )));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(line: &str) -> Result<Command> {
        parse(
            &line
                .split_whitespace()
                .map(String::from)
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn parses_the_offline_commands() {
        assert_eq!(
            parsed("clone r1 work --origin http://x").ok(),
            Some(Command::Clone {
                repo: "r1".into(),
                dir: Some("work".into()),
                origin: Some("http://x".into())
            })
        );
        assert_eq!(
            parsed("sync --land").ok(),
            Some(Command::Sync(SyncMode::Land))
        );
        assert_eq!(
            parsed("sync --attempt external-1").ok(),
            Some(Command::Sync(SyncMode::Attempt {
                id: "external-1".into(),
                mcp_url: None
            }))
        );
        assert_eq!(parsed("").ok(), Some(Command::Help));
        assert_eq!(
            parsed("status --brief").ok(),
            Some(Command::Status { brief: true })
        );
        assert_eq!(
            parsed("push --force origin main").ok(),
            Some(Command::Push(vec![
                "--force".into(),
                "origin".into(),
                "main".into()
            ]))
        );
        assert_eq!(
            parsed("reads add src/a.rs docs/").ok(),
            Some(Command::Reads(ReadsCommand::Add {
                paths: vec!["src/a.rs".into(), "docs/".into()]
            }))
        );
        assert_eq!(
            parsed("hook claude-stop").ok(),
            Some(Command::Hook(HookEvent::ClaudeStop))
        );
        assert_eq!(
            parsed("session record abc --cli codex --summary done").ok(),
            Some(Command::Session {
                target: Target::default(),
                command: SessionCommand::Record {
                    commit: Some("abc".into()),
                    cli: "codex".into(),
                    summary: "done".into(),
                    model: None,
                    transcript_ref: None
                }
            })
        );
    }

    #[test]
    fn parses_the_account_and_repository_commands() {
        assert_eq!(
            parsed("login --no-browser").ok(),
            Some(Command::Login {
                origin: None,
                with_token: false,
                browser: false
            })
        );
        assert_eq!(
            parsed("repo create web --owner acme").ok(),
            Some(Command::Repo {
                origin: None,
                command: RepoCommand::Create {
                    name: "web".into(),
                    owner: Some("acme".into())
                }
            })
        );
        assert_eq!(
            parsed("repo delete r1 --confirm demo").ok(),
            Some(Command::Repo {
                origin: None,
                command: RepoCommand::Delete {
                    id: "r1".into(),
                    confirm: "demo".into()
                }
            })
        );
        assert_eq!(
            parsed("repo import ./src --batch-files 3").ok(),
            Some(Command::Repo {
                origin: None,
                command: RepoCommand::Import {
                    dir: "./src".into(),
                    name: None,
                    batch_files: 3
                }
            })
        );
        assert_eq!(
            parsed("rebase topic/x --onto release --repo r2").ok(),
            Some(Command::Rebase {
                target: Target {
                    origin: None,
                    repo: Some("r2".into())
                },
                branch: "topic/x".into(),
                onto: Some("release".into())
            })
        );
        assert!(parsed("rebase").is_err());
        assert_eq!(
            parsed("review reject abc -m nope --repo r2").ok(),
            Some(Command::Review {
                target: Target {
                    origin: None,
                    repo: Some("r2".into())
                },
                approve: false,
                commit: "abc".into(),
                reason: Some("nope".into())
            })
        );
        assert_eq!(
            parsed("grep needle -i --at 7").ok(),
            Some(Command::Read {
                target: Target::default(),
                command: ReadCommand::Grep {
                    query: "needle".into(),
                    path: None,
                    ignore_case: true,
                    at: Some(7)
                }
            })
        );
        // Every read command takes --at <version>.
        assert_eq!(
            parsed("blame src/a.rs --ref main --at 4").ok(),
            Some(Command::Read {
                target: Target::default(),
                command: ReadCommand::Blame {
                    path: "src/a.rs".into(),
                    branch: Some("main".into()),
                    at: Some(4)
                }
            })
        );
        assert_eq!(
            parsed("token create ci --scopes read,check").ok(),
            Some(Command::Token {
                target: Target::default(),
                command: TokenCommand::Create {
                    name: "ci".into(),
                    scopes: vec!["read".into(), "check".into()],
                    paths: None
                }
            })
        );
        assert_eq!(
            parsed("change create fix --title Retry -m why").ok(),
            Some(Command::Change {
                target: Target::default(),
                command: ChangeCommand::Create {
                    branch: Some("fix".into()),
                    title: Some("Retry".into()),
                    body: Some("why".into())
                }
            })
        );
        assert_eq!(
            parsed("change comment #3 --path src/a.rs --line 7 --side new --resolve").ok(),
            Some(Command::Change {
                target: Target::default(),
                command: ChangeCommand::Comment {
                    number: 3,
                    body: None,
                    anchor: Some(Anchor {
                        path: "src/a.rs".into(),
                        line: 7,
                        side: "new".into()
                    }),
                    resolve: true
                }
            })
        );
        assert_eq!(
            parsed("change land 2 --repo r2").ok(),
            Some(Command::Change {
                target: Target {
                    origin: None,
                    repo: Some("r2".into())
                },
                command: ChangeCommand::Land { number: 2 }
            })
        );
        assert_eq!(
            parsed("release create v1 --title First -m notes --asset dist/app.zip").ok(),
            Some(Command::Release {
                target: Target::default(),
                command: ReleaseCommand::Create {
                    tag: "v1".into(),
                    title: Some("First".into()),
                    notes: Some("notes".into()),
                    asset: Some("dist/app.zip".into())
                }
            })
        );
        assert_eq!(
            parsed("release show v1").ok(),
            Some(Command::Release {
                target: Target::default(),
                command: ReleaseCommand::Show { tag: "v1".into() }
            })
        );
        assert_eq!(
            parsed("setup codex").ok(),
            Some(Command::Setup {
                agent: Agent::Codex,
                origin: None
            })
        );
    }

    #[test]
    fn parses_the_org_commands() {
        let org = |line: &str| match parsed(line) {
            Ok(Command::Org { command, .. }) => Some(command),
            _ => None,
        };
        assert_eq!(org("org list"), Some(OrgCommand::List));
        assert_eq!(
            org("org create acme --origin https://x"),
            Some(OrgCommand::Create {
                name: "acme".into()
            })
        );
        assert_eq!(
            org("org show acme"),
            Some(OrgCommand::Show { org: "acme".into() })
        );
        assert_eq!(
            org("org repos acme"),
            Some(OrgCommand::Repos { org: "acme".into() })
        );
        assert_eq!(
            org("org member add acme bob"),
            Some(OrgCommand::MemberAdd {
                org: "acme".into(),
                account: "bob".into(),
                role: "member".into()
            })
        );
        assert_eq!(
            org("org member add acme bob --role owner"),
            Some(OrgCommand::MemberAdd {
                org: "acme".into(),
                account: "bob".into(),
                role: "owner".into()
            })
        );
        assert_eq!(
            org("org member remove acme bob"),
            Some(OrgCommand::MemberRemove {
                org: "acme".into(),
                account: "bob".into()
            })
        );
        assert_eq!(
            org("org team create acme devs"),
            Some(OrgCommand::TeamCreate {
                org: "acme".into(),
                team: "devs".into()
            })
        );
        assert_eq!(
            org("org team delete acme devs"),
            Some(OrgCommand::TeamDelete {
                org: "acme".into(),
                team: "devs".into()
            })
        );
        assert_eq!(
            org("org team add acme devs bob"),
            Some(OrgCommand::TeamAdd {
                org: "acme".into(),
                team: "devs".into(),
                account: "bob".into()
            })
        );
        assert_eq!(
            org("org team remove acme devs bob"),
            Some(OrgCommand::TeamRemove {
                org: "acme".into(),
                team: "devs".into(),
                account: "bob".into()
            })
        );
        assert_eq!(
            parsed("org show acme --origin https://y").ok(),
            Some(Command::Org {
                origin: Some("https://y".into()),
                command: OrgCommand::Show { org: "acme".into() }
            })
        );
    }

    #[test]
    fn refuses_bad_lines_with_usage_code() {
        for line in [
            "sync --land --attempt a",
            "clone",
            "status extra",
            "reads",
            "reads add",
            "session record abc --cli x",
            "hook vim",
            "repo delete r1",
            "repo",
            "review maybe abc",
            "log --at soon",
            "setup vim",
            "repo import d --batch-files 0",
            "change show",
            "change show 0",
            "change land x",
            "change comment 1",
            "change comment 1 -m hi --path a.rs --line 2",
            "change comment 1 -m hi --path a.rs --line 2 --side left",
            "change comment 1 --resolve",
            "change list extra",
            "release create",
            "release show",
            "release list extra",
            "release publish v1",
            "org",
            "org create",
            "org show a b",
            "org member add acme",
            "org member add acme bob --role admin",
            "org member remove acme bob --role owner",
            "org team create acme",
            "org team add acme devs",
            "org team rename acme devs x",
            "org delete acme",
        ] {
            assert_eq!(
                parsed(line).map_err(|e| e.exit_code).err(),
                Some(64),
                "{line}"
            );
        }
    }
}
