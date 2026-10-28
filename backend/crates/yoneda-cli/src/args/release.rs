//! `yoneda release …`: releases of existing tags, with downloadable assets.
use super::parser::{Parsed, split_sub, with};
use crate::command::{Command, ReleaseCommand};
use crate::error::{Error, Result};

pub fn release(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "release")?;
    let p = Parsed::new(&rest, &with(&["title", "message", "asset"]), &[])?;
    let command = match sub.as_str() {
        "create" => ReleaseCommand::Create {
            tag: p.exactly(1, "release create <tag>")?[0].clone(),
            title: p.flag("title"),
            notes: p.flag("message"),
            asset: p.flag("asset"),
        },
        "list" => {
            p.at_most(0)?;
            ReleaseCommand::List
        }
        "show" => ReleaseCommand::Show {
            tag: p.exactly(1, "release show <tag>")?[0].clone(),
        },
        other => return Err(Error::usage(format!("unknown release command {other:?}"))),
    };
    Ok(Command::Release {
        target: p.target(),
        command,
    })
}
