//! Subcommand families: repo, token, reads, check, sync, declared reads, sessions, hooks.
use super::parser::{Parsed, list, split_sub, with};
use crate::command::{
    CheckCommand, Command, HookEvent, ReadCommand, ReadsCommand, RepoCommand, SessionCommand,
    SyncMode, TokenCommand,
};
use crate::error::{Error, Result};

pub fn repo(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "repo")?;
    let p = Parsed::new(&rest, &["origin", "confirm", "name", "batch-files"], &[])?;
    let command = match sub.as_str() {
        "create" => RepoCommand::Create {
            name: p.exactly(1, "repo create <name>")?[0].clone(),
        },
        "list" => {
            p.at_most(0)?;
            RepoCommand::List
        }
        "delete" => RepoCommand::Delete {
            id: p.exactly(1, "repo delete <id> --confirm <name>")?[0].clone(),
            confirm: p
                .flag("confirm")
                .ok_or_else(|| Error::usage("repo delete needs --confirm <name>"))?,
        },
        "import" => RepoCommand::Import {
            dir: p.exactly(1, "repo import <dir>")?[0].clone(),
            name: p.flag("name"),
            batch_files: match p.number("batch-files")? {
                Some(0) => return Err(Error::usage("--batch-files must be at least 1")),
                Some(n) => usize::try_from(n).unwrap_or(usize::MAX),
                None => crate::import::BATCH_FILES,
            },
        },
        other => return Err(Error::usage(format!("unknown repo command {other:?}"))),
    };
    Ok(Command::Repo {
        origin: p.flag("origin"),
        command,
    })
}

pub fn token(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "token")?;
    let p = Parsed::new(&rest, &with(&["scopes", "paths"]), &[])?;
    let command = match sub.as_str() {
        "create" => TokenCommand::Create {
            name: p.exactly(1, "token create <name>")?[0].clone(),
            scopes: list(p.flag("scopes")).unwrap_or_else(|| vec!["read".into(), "write".into()]),
            paths: list(p.flag("paths")),
        },
        "list" => {
            p.at_most(0)?;
            TokenCommand::List
        }
        "revoke" => TokenCommand::Revoke {
            name: p.exactly(1, "token revoke <name>")?[0].clone(),
        },
        other => return Err(Error::usage(format!("unknown token command {other:?}"))),
    };
    Ok(Command::Token {
        target: p.target(),
        command,
    })
}

pub fn read(command: &str, rest: &[String]) -> Result<Command> {
    let p = Parsed::new(
        rest,
        &with(&["ref", "limit", "at", "path"]),
        &["ignore-case"],
    )?;
    let at = p.number("at")?;
    let command = match command {
        "log" => {
            p.at_most(1)?;
            ReadCommand::Log {
                path: p.positional.first().cloned(),
                branch: p.flag("ref"),
                limit: p.number("limit")?,
                at,
            }
        }
        "grep" => ReadCommand::Grep {
            query: p.exactly(1, "grep <query>")?[0].clone(),
            path: p.flag("path"),
            ignore_case: p.on("ignore-case"),
            at,
        },
        "blame" => ReadCommand::Blame {
            path: p.exactly(1, "blame <path>")?[0].clone(),
            branch: p.flag("ref"),
            at,
        },
        "diff" => {
            p.at_most(2)?;
            ReadCommand::Diff {
                base: p.positional.first().cloned(),
                head: p.positional.get(1).cloned(),
                path: p.flag("path"),
                at,
            }
        }
        _ => ReadCommand::Symbols {
            path: p.exactly(1, "symbols <path>")?[0].clone(),
            at,
        },
    };
    Ok(Command::Read {
        target: p.target(),
        command,
    })
}

pub fn check(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "check")?;
    let p = Parsed::new(&rest, &with(&["commit"]), &[])?;
    let command = match sub.as_str() {
        "run" => CheckCommand::Run {
            name: p.exactly(1, "check run <name>")?[0].clone(),
            commit: p.flag("commit"),
        },
        "status" => {
            p.at_most(1)?;
            CheckCommand::Status {
                run: p.positional.first().cloned(),
                commit: p.flag("commit"),
            }
        }
        other => return Err(Error::usage(format!("unknown check command {other:?}"))),
    };
    Ok(Command::Check {
        target: p.target(),
        command,
    })
}

pub fn sync(rest: &[String]) -> Result<Command> {
    let p = Parsed::new(rest, &["attempt", "mcp-url"], &["land"])?;
    p.at_most(0)?;
    let mode = match (p.on("land"), p.flag("attempt")) {
        (true, Some(_)) => return Err(Error::usage("choose either --land or --attempt")),
        (true, None) => SyncMode::Land,
        (false, Some(id)) => SyncMode::Attempt {
            id,
            mcp_url: p.flag("mcp-url"),
        },
        (false, None) => SyncMode::Push,
    };
    Ok(Command::Sync(mode))
}

pub fn declared_reads(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "reads")?;
    let p = Parsed::new(&rest, &[], &[])?;
    Ok(Command::Reads(match sub.as_str() {
        "add" if !p.positional.is_empty() => ReadsCommand::Add {
            paths: p.positional.clone(),
        },
        "add" => return Err(Error::usage("expected reads add <path>...")),
        "list" => {
            p.at_most(0)?;
            ReadsCommand::List
        }
        "clear" => {
            p.at_most(0)?;
            ReadsCommand::Clear
        }
        other => return Err(Error::usage(format!("unknown reads command {other:?}"))),
    }))
}

pub fn session(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "session")?;
    let p = Parsed::new(
        &rest,
        &with(&["cli", "summary", "model", "transcript-ref"]),
        &[],
    )?;
    p.at_most(1)?;
    let commit = p.positional.first().cloned();
    let command = match sub.as_str() {
        "record" => SessionCommand::Record {
            commit,
            cli: p
                .flag("cli")
                .ok_or_else(|| Error::usage("session record needs --cli <name>"))?,
            summary: p
                .flag("summary")
                .ok_or_else(|| Error::usage("session record needs --summary <text>"))?,
            model: p.flag("model"),
            transcript_ref: p.flag("transcript-ref"),
        },
        "list" => SessionCommand::List { commit },
        other => return Err(Error::usage(format!("unknown session command {other:?}"))),
    };
    Ok(Command::Session {
        target: p.target(),
        command,
    })
}

pub fn hook(rest: &[String]) -> Result<Command> {
    let p = Parsed::new(rest, &[], &[])?;
    Ok(Command::Hook(
        match p.exactly(1, "hook claude-read|claude-bash|claude-stop")?[0].as_str() {
            "claude-read" => HookEvent::ClaudeRead,
            "claude-bash" => HookEvent::ClaudeBash,
            "claude-stop" => HookEvent::ClaudeStop,
            other => return Err(Error::usage(format!("unknown hook {other:?}"))),
        },
    ))
}
