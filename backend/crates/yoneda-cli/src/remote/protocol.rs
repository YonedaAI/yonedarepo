//! The line protocol between Git and the helper (gitremote-helpers(7)).
use super::{Options, Session, list, push};
use crate::error::{Context, Error, Result};
use std::io::{BufRead, Write};

/// One command from Git.
#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    Capabilities,
    Option {
        name: String,
        value: String,
    },
    List {
        for_push: bool,
    },
    Fetch {
        sha: String,
    },
    Push(push::Spec),
    /// The blank line ending a batch, or the session.
    End,
}

pub fn parse(line: &str) -> Result<Request> {
    let line = line.trim_end_matches(['\n', '\r']);
    let mut words = line.splitn(3, ' ');
    Ok(match (words.next(), words.next(), words.next()) {
        (Some(""), None, None) => Request::End,
        (Some("capabilities"), None, None) => Request::Capabilities,
        (Some("list"), None, None) => Request::List { for_push: false },
        (Some("list"), Some("for-push"), None) => Request::List { for_push: true },
        (Some("option"), Some(name), value) => Request::Option {
            name: name.to_owned(),
            value: value.unwrap_or_default().to_owned(),
        },
        (Some("fetch"), Some(sha), Some(_name)) => Request::Fetch {
            sha: sha.to_owned(),
        },
        (Some("push"), Some(spec), None) => Request::Push(push::Spec::parse(spec)?),
        _ => return Err(Error::new(format!("unsupported helper command {line:?}"))),
    })
}

/// Applies `option <name> <value>`; returns Git's answer.
pub fn option(options: &mut Options, name: &str, value: &str) -> &'static str {
    let on = value == "true";
    match name {
        "verbosity" => {
            options.verbosity = value.parse().unwrap_or(1);
            "ok"
        }
        "atomic" => {
            options.atomic = on;
            "ok"
        }
        "dry-run" => {
            options.dry_run = on;
            "ok"
        }
        // Accepted without effect: progress goes to stderr either way, there are no tags.
        "progress" | "followtags" | "cloning" => "ok",
        _ => "unsupported",
    }
}

fn reply(out: &mut impl Write, text: &str) -> Result<()> {
    out.write_all(text.as_bytes())
        .and_then(|()| out.flush())
        .context("answering git")
}

/// Serves Git's commands until the session ends.
pub fn serve(
    session: &mut Session,
    rt: &tokio::runtime::Runtime,
    input: &mut impl BufRead,
    out: &mut impl Write,
) -> Result<()> {
    let mut pushes = Vec::new();
    let mut fetching = false;
    loop {
        let mut line = String::new();
        if input.read_line(&mut line).context("reading from git")? == 0 {
            return Ok(());
        }
        match parse(&line)? {
            Request::Capabilities => reply(out, "fetch\npush\noption\n\n")?,
            Request::Option { name, value } => {
                let answer = option(&mut session.options, &name, &value);
                reply(out, &format!("{answer}\n"))?;
            }
            Request::List { for_push } => {
                let listed = rt.block_on(list::list(session, for_push))?;
                reply(out, &listed)?;
            }
            Request::Fetch { sha } => {
                // `list` already converted every branch; fetch only confirms it.
                if !session
                    .git
                    .succeeds(&["cat-file", "-e", &format!("{sha}^{{commit}}")])
                {
                    return Err(Error::new(format!(
                        "{sha} was not listed by this helper; fetch again"
                    )));
                }
                fetching = true;
            }
            Request::Push(spec) => pushes.push(spec),
            Request::End if fetching => {
                fetching = false;
                reply(out, "\n")?;
            }
            Request::End if !pushes.is_empty() => {
                let report = rt.block_on(push::push(session, std::mem::take(&mut pushes)));
                reply(out, &format!("{report}\n"))?;
            }
            Request::End => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_helper_command() -> Result<()> {
        assert_eq!(parse("capabilities\n")?, Request::Capabilities);
        assert_eq!(parse("list for-push\n")?, Request::List { for_push: true });
        assert_eq!(
            parse("option dry-run true\n")?,
            Request::Option {
                name: "dry-run".into(),
                value: "true".into()
            }
        );
        assert_eq!(
            parse(&format!("fetch {} refs/heads/main\n", "a".repeat(40)))?,
            Request::Fetch {
                sha: "a".repeat(40)
            }
        );
        assert_eq!(
            parse("push +refs/heads/x:refs/heads/y\n")?,
            Request::Push(push::Spec {
                force: true,
                src: "refs/heads/x".into(),
                dst: "refs/heads/y".into()
            })
        );
        assert_eq!(parse("\n")?, Request::End);
        assert!(parse("import refs/heads/main\n").is_err());
        Ok(())
    }

    #[test]
    fn answers_options() {
        let mut options = Options::default();
        assert_eq!(option(&mut options, "atomic", "true"), "ok");
        assert_eq!(option(&mut options, "verbosity", "2"), "ok");
        assert_eq!(option(&mut options, "depth", "1"), "unsupported");
        assert!(options.atomic && options.verbosity == 2 && !options.dry_run);
    }
}
