//! One command's flags and positionals, parsed from a table of flag names.
use crate::command::{Target, USAGE};
use crate::error::{Error, Result};
use std::collections::HashMap;

pub struct Parsed {
    flags: HashMap<String, String>,
    pub positional: Vec<String>,
}

impl Parsed {
    /// `values` take an argument; `switches` do not. `-m`, `-i` and `-w` are short forms.
    pub fn new(args: &[String], values: &[&str], switches: &[&str]) -> Result<Self> {
        let (mut flags, mut positional) = (HashMap::new(), Vec::new());
        let mut rest = args.iter();
        while let Some(arg) = rest.next() {
            let name = match arg.as_str() {
                "-m" => "message",
                "-i" => "ignore-case",
                "-w" => "word",
                other => match other.strip_prefix("--") {
                    Some(name) => name,
                    None => {
                        positional.push(arg.clone());
                        continue;
                    }
                },
            };
            // `--json` (any command; see `output::requested`) is read from argv in `run`.
            if name == "json" {
                continue;
            }
            if switches.contains(&name) {
                flags.insert(name.to_owned(), String::new());
            } else if values.contains(&name) {
                let value = rest
                    .next()
                    .ok_or_else(|| Error::usage(format!("--{name} needs a value")))?;
                flags.insert(name.to_owned(), value.clone());
            } else {
                return Err(Error::usage(format!("unknown option {arg}\n\n{USAGE}")));
            }
        }
        Ok(Self { flags, positional })
    }

    pub fn flag(&self, name: &str) -> Option<String> {
        self.flags.get(name).cloned()
    }

    pub fn on(&self, name: &str) -> bool {
        self.flags.contains_key(name)
    }

    pub fn number(&self, name: &str) -> Result<Option<u64>> {
        self.flag(name)
            .map(|v| {
                v.parse()
                    .map_err(|_| Error::usage(format!("--{name} must be a number")))
            })
            .transpose()
    }

    pub fn target(&self) -> Target {
        Target {
            origin: self.flag("origin"),
            repo: self.flag("repo"),
        }
    }

    /// Exactly `n` positionals (`what` names them for the error).
    pub fn exactly(&self, n: usize, what: &str) -> Result<&[String]> {
        if self.positional.len() == n {
            Ok(&self.positional)
        } else {
            Err(Error::usage(format!("expected {what}")))
        }
    }

    pub fn at_most(&self, n: usize) -> Result<()> {
        match self.positional.get(n) {
            Some(extra) => Err(Error::usage(format!("unexpected argument {extra:?}"))),
            None => Ok(()),
        }
    }
}

/// A comma-separated list flag.
pub fn list(value: Option<String>) -> Option<Vec<String>> {
    value.map(|v| {
        v.split(',')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    })
}

/// Flags every repository command takes, plus `extra`.
pub fn with<'a>(extra: &[&'a str]) -> Vec<&'a str> {
    ["origin", "repo"]
        .into_iter()
        .chain(extra.iter().copied())
        .collect()
}

/// A subcommand and its arguments.
pub fn split_sub(rest: &[String], what: &str) -> Result<(String, Vec<String>)> {
    rest.split_first()
        .map(|(s, r)| (s.clone(), r.to_vec()))
        .ok_or_else(|| Error::usage(format!("{what} needs a subcommand\n\n{USAGE}")))
}
