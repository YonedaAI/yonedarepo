//! `yoneda ssh-key …`: the account's SSH public keys (account-level, like `org`).
use super::parser::{Parsed, split_sub};
use crate::command::{Command, SshKeyCommand};
use crate::error::{Error, Result};

pub fn ssh_key(rest: &[String]) -> Result<Command> {
    let (sub, rest) = split_sub(rest, "ssh-key")?;
    let p = Parsed::new(&rest, &["origin", "title"], &[])?;
    if sub != "add" && p.flag("title").is_some() {
        return Err(Error::usage("only ssh-key add takes --title"));
    }
    let command = match sub.as_str() {
        "add" => SshKeyCommand::Add {
            source: p.exactly(1, "ssh-key add [--title <t>] <file.pub|->")?[0].clone(),
            title: p.flag("title"),
        },
        "list" | "ls" => {
            p.at_most(0)?;
            SshKeyCommand::List
        }
        "rm" | "remove" => SshKeyCommand::Remove {
            id: p.exactly(1, "ssh-key rm <id>")?[0].clone(),
        },
        other => return Err(Error::usage(format!("unknown ssh-key command {other:?}"))),
    };
    Ok(Command::SshKey {
        origin: p.flag("origin"),
        command,
    })
}

#[cfg(test)]
mod tests {
    use crate::command::{Command, SshKeyCommand};

    fn parsed(line: &str) -> crate::error::Result<Command> {
        let args: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
        crate::args::parse(&args)
    }

    #[test]
    fn parses_the_ssh_key_commands() {
        assert_eq!(
            parsed("ssh-key add ~/.ssh/id_ed25519.pub --title laptop --origin https://x").ok(),
            Some(Command::SshKey {
                origin: Some("https://x".into()),
                command: SshKeyCommand::Add {
                    source: "~/.ssh/id_ed25519.pub".into(),
                    title: Some("laptop".into()),
                },
            })
        );
        assert_eq!(
            parsed("ssh-key add -").ok(),
            Some(Command::SshKey {
                origin: None,
                command: SshKeyCommand::Add {
                    source: "-".into(),
                    title: None,
                },
            })
        );
        assert_eq!(
            parsed("ssh-key list").ok(),
            Some(Command::SshKey {
                origin: None,
                command: SshKeyCommand::List,
            })
        );
        assert_eq!(
            parsed("ssh-key rm ssh_0123456789abcdef").ok(),
            Some(Command::SshKey {
                origin: None,
                command: SshKeyCommand::Remove {
                    id: "ssh_0123456789abcdef".into(),
                },
            })
        );
    }

    #[test]
    fn refuses_malformed_ssh_key_commands() {
        for line in [
            "ssh-key",
            "ssh-key add",
            "ssh-key add a.pub b.pub",
            "ssh-key list extra",
            "ssh-key rm",
            "ssh-key rm ssh_1 --title x",
            "ssh-key rotate",
        ] {
            assert!(parsed(line).is_err(), "{line} should be refused");
        }
    }
}
