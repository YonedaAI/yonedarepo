//! Command-line parsing: a small table-driven parser (no framework). The command set is
//! wide but each command has a handful of flags; clap would add more than it removes.
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
            parsed("setup codex").ok(),
            Some(Command::Setup {
                agent: Agent::Codex,
                origin: None
            })
        );
    }

    #[test]
    fn refuses_bad_lines_with_usage_code() {
        for line in [
            "sync --land --attempt a",
            "clone",
            "status extra",
            "push",
            "repo delete r1",
            "repo",
            "review maybe abc",
            "log --at soon",
            "setup vim",
            "repo import d --batch-files 0",
        ] {
            assert_eq!(
                parsed(line).map_err(|e| e.exit_code).err(),
                Some(64),
                "{line}"
            );
        }
    }
}
