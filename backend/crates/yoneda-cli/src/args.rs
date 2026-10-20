//! Command-line parsing. Five commands with a handful of flags do not need a framework.
use crate::error::{Error, Result};

pub const USAGE: &str = "\
usage:
  yoneda login --origin <url>            read a platform token from stdin and store it
  yoneda clone <repo-id> [dir] [--origin <url>]
  yoneda status                          base version, pending commits, platform lag
  yoneda sync [--land | --attempt <id> [--mcp-url <url>]]
  yoneda pull                            rebase pending commits onto the current main

The token comes from YONEDA_TOKEN when set, else from `yoneda login`.";

#[derive(Debug, PartialEq, Eq)]
pub enum SyncMode {
    /// Push the pending commits to this checkout's offline branch.
    Push,
    /// Push, then land the series on the base branch.
    Land,
    /// Commit through a remote MCP contribution attempt, then submit it.
    Attempt { id: String, mcp_url: Option<String> },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Login {
        origin: String,
    },
    Clone {
        repo: String,
        dir: Option<String>,
        origin: Option<String>,
    },
    Status,
    Sync(SyncMode),
    Pull,
    Help,
}

/// Flags with their values, then positionals.
type Split = (Vec<(String, String)>, Vec<String>);

/// Splits `args` (without the program name) into flags with values and positionals.
fn split(args: &[String], flags: &[&str]) -> Result<Split> {
    let (mut named, mut positional) = (Vec::new(), Vec::new());
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if let Some(name) = arg.strip_prefix("--") {
            if name == "land" {
                named.push((name.to_owned(), String::new()));
                continue;
            }
            if !flags.contains(&name) {
                return Err(Error::usage(format!("unknown option --{name}\n\n{USAGE}")));
            }
            let value = rest
                .next()
                .ok_or_else(|| Error::usage(format!("--{name} needs a value")))?;
            named.push((name.to_owned(), value.clone()));
        } else {
            positional.push(arg.clone());
        }
    }
    Ok((named, positional))
}

fn flag(named: &[(String, String)], name: &str) -> Option<String> {
    named
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.clone())
}

fn no_positionals(positional: &[String]) -> Result<()> {
    match positional.first() {
        Some(extra) => Err(Error::usage(format!("unexpected argument {extra:?}"))),
        None => Ok(()),
    }
}

pub fn parse(args: &[String]) -> Result<Command> {
    let Some((command, rest)) = args.split_first() else {
        return Ok(Command::Help);
    };
    match command.as_str() {
        "login" => {
            let (named, positional) = split(rest, &["origin"])?;
            no_positionals(&positional)?;
            let origin =
                flag(&named, "origin").ok_or_else(|| Error::usage("login needs --origin <url>"))?;
            Ok(Command::Login { origin })
        }
        "clone" => {
            let (named, positional) = split(rest, &["origin"])?;
            let mut positional = positional.into_iter();
            let repo = positional
                .next()
                .ok_or_else(|| Error::usage("clone needs a repository id"))?;
            let dir = positional.next();
            no_positionals(&positional.collect::<Vec<_>>())?;
            Ok(Command::Clone {
                repo,
                dir,
                origin: flag(&named, "origin"),
            })
        }
        "status" | "pull" => {
            no_positionals(rest)?;
            Ok(if command == "status" {
                Command::Status
            } else {
                Command::Pull
            })
        }
        "sync" => {
            let (named, positional) = split(rest, &["attempt", "mcp-url"])?;
            no_positionals(&positional)?;
            let land = named.iter().any(|(n, _)| n == "land");
            let mode = match (land, flag(&named, "attempt")) {
                (true, Some(_)) => {
                    return Err(Error::usage("choose either --land or --attempt"));
                }
                (true, None) => SyncMode::Land,
                (false, Some(id)) => SyncMode::Attempt {
                    id,
                    mcp_url: flag(&named, "mcp-url"),
                },
                (false, None) => SyncMode::Push,
            };
            Ok(Command::Sync(mode))
        }
        "help" | "--help" | "-h" => Ok(Command::Help),
        other => Err(Error::usage(format!(
            "unknown command {other:?}\n\n{USAGE}"
        ))),
    }
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
    fn parses_each_command() {
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
    }

    #[test]
    fn refuses_bad_lines_with_usage_code() {
        for line in [
            "sync --land --attempt a",
            "login",
            "clone",
            "status extra",
            "push",
        ] {
            assert_eq!(
                parsed(line).map_err(|e| e.exit_code).err(),
                Some(64),
                "{line}"
            );
        }
    }
}
