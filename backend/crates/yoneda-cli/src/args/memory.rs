//! `yoneda memory …`: the repository's memories.
use super::parser::{Parsed, list, split_sub, with};
use crate::command::{Command, MemoryCommand};
use crate::error::{Error, Result};

fn id(p: &Parsed, what: &str) -> Result<u64> {
    p.exactly(1, what)?[0]
        .parse()
        .map_err(|_| Error::usage(format!("expected {what}")))
}

pub fn memory(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "memory")?;
    let p = Parsed::new(
        &rest,
        &with(&[
            "message",
            "anchors",
            "supersedes",
            "commit",
            "path",
            "kind",
            "status",
        ]),
        &["json"],
    )?;
    let command = match sub.as_str() {
        "add" => MemoryCommand::Add {
            kind: p.exactly(1, "memory add <decision|constraint|gotcha|howto> -m <text>")?[0]
                .clone(),
            text: p
                .flag("message")
                .ok_or_else(|| Error::usage("memory add needs -m <text>"))?,
            anchors: list(p.flag("anchors")).unwrap_or_default(),
            supersedes: p.number("supersedes")?,
            commit: p.flag("commit"),
        },
        "list" => {
            p.at_most(0)?;
            MemoryCommand::List {
                path: p.flag("path"),
                kind: p.flag("kind"),
                status: p.flag("status"),
                json: p.on("json"),
            }
        }
        "show" => MemoryCommand::Show {
            id: id(&p, "memory show <id>")?,
            json: p.on("json"),
        },
        "retire" => MemoryCommand::Retire {
            id: id(&p, "memory retire <id>")?,
            reason: p.flag("message"),
        },
        other => return Err(Error::usage(format!("unknown memory command {other:?}"))),
    };
    Ok(Command::Memory {
        target: p.target(),
        command,
    })
}
