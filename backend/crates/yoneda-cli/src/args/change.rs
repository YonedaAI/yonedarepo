//! `yoneda change …`: change requests, their comments and reviews.
use super::parser::{Parsed, split_sub, with};
use crate::command::{Anchor, ChangeCommand, Command};
use crate::error::{Error, Result};

pub fn change(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "change")?;
    let p = Parsed::new(
        &rest,
        &with(&["title", "message", "base", "status", "path", "line", "side"]),
        &["resolve", "to-parent"],
    )?;
    let number = || -> Result<u64> {
        p.exactly(1, &format!("change {sub} <number>"))?[0]
            .trim_start_matches('#')
            .parse()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| Error::usage("a change number is a positive integer"))
    };
    let command = match sub.as_str() {
        "create" => {
            p.at_most(1)?;
            ChangeCommand::Create {
                branch: p.positional.first().cloned(),
                title: p.flag("title"),
                body: p.flag("message"),
                base: p.flag("base"),
                to_parent: p.on("to-parent"),
            }
        }
        "list" => {
            p.at_most(0)?;
            ChangeCommand::List {
                status: p.flag("status"),
            }
        }
        "show" => ChangeCommand::Show { number: number()? },
        "land" => ChangeCommand::Land { number: number()? },
        "comment" => {
            let anchor = match (p.flag("path"), p.number("line")?, p.flag("side")) {
                (None, None, None) => None,
                (Some(path), Some(line), Some(side)) if ["old", "new"].contains(&side.as_str()) => {
                    Some(Anchor { path, line, side })
                }
                _ => {
                    return Err(Error::usage(
                        "an anchored comment needs --path, --line and --side old|new",
                    ));
                }
            };
            let (body, resolve) = (p.flag("message"), p.on("resolve"));
            if body.is_none() && !(resolve && anchor.is_some()) {
                return Err(Error::usage(
                    "change comment needs -m <text> (or --resolve with an anchor)",
                ));
            }
            ChangeCommand::Comment {
                number: number()?,
                body,
                anchor,
                resolve,
            }
        }
        other => return Err(Error::usage(format!("unknown change command {other:?}"))),
    };
    Ok(Command::Change {
        target: p.target(),
        command,
    })
}
