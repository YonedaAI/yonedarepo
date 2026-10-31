//! Server-side reads: log, grep, search, blame, diff and symbols.
use super::parser::{Parsed, list, with};
use crate::command::{Command, ReadCommand};
use crate::error::{Error, Result};

/// `search <query> --all`: main's code and the newest records across the account, so it takes
/// neither a repository nor a revision.
fn search_all(command: &str, p: &Parsed) -> Result<Command> {
    let bound = ["repo", "ref", "at", "path"]
        .iter()
        .any(|f| p.flag(f).is_some());
    if command != "search" || bound {
        return Err(Error::usage(
            "--all goes with search, and without --repo, --ref, --at or --path",
        ));
    }
    Ok(Command::SearchAll {
        origin: p.flag("origin"),
        query: p.exactly(1, "search <query> --all")?[0].clone(),
        groups: list(p.flag("in")),
        limit: p.number("limit")?,
        word: p.on("word"),
        after: p.flag("after"),
    })
}

pub fn read(command: &str, rest: &[String]) -> Result<Command> {
    let p = Parsed::new(
        rest,
        &with(&["ref", "limit", "at", "path", "in", "after"]),
        &["ignore-case", "word", "all"],
    )?;
    let at = p.number("at")?;
    if p.on("all") {
        return search_all(command, &p);
    }
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
            word: p.on("word"),
            at,
        },
        "search" => ReadCommand::Search {
            query: p.exactly(1, "search <query>")?[0].clone(),
            groups: list(p.flag("in")),
            path: p.flag("path"),
            branch: p.flag("ref"),
            limit: p.number("limit")?,
            word: p.on("word"),
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
