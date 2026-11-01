//! How far dependencies are behind, from what the tools already know: `cargo update --dry-run`
//! (which changes nothing) and `pnpm outdated`. Reports only; AGENTS.md sets the policy.
use crate::process::Result;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::process::Command;

/// One dependency behind its newest release.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct Lag {
    pub name: String,
    pub current: String,
    pub latest: String,
}

impl Lag {
    fn new(name: &str, current: &str, latest: &str) -> Self {
        let plain = |version: &str| version.trim_start_matches('v').to_owned();
        Lag {
            name: name.to_owned(),
            current: plain(current),
            latest: plain(latest),
        }
    }

    /// Whether the update can break callers: a new first nonzero version number.
    pub(super) fn is_breaking(&self) -> bool {
        let numbers = |version: &str| -> Vec<u64> {
            let release = version.split(['-', '+']).next().unwrap_or(version);
            release.split('.').flat_map(str::parse).collect()
        };
        let (old, new) = (numbers(&self.current), numbers(&self.latest));
        let first = old.iter().position(|number| *number != 0).unwrap_or(0);
        old.get(..=first) != new.get(..=first)
    }
}

/// `    Updating a v1.0.0 -> v1.0.1` and `   Unchanged b v1.0.0 (available: v2.0.0)`.
pub(super) fn parse_cargo(text: &str) -> Vec<Lag> {
    let rows = text.lines().map(str::split_whitespace);
    rows.filter_map(|mut words| {
        let (verb, name, current) = (words.next()?, words.next()?, words.next()?);
        let rest: Vec<&str> = words.collect();
        match (verb, &rest[..]) {
            ("Updating", ["->", latest]) => Some(Lag::new(name, current, latest)),
            ("Unchanged", ["(available:", latest]) => {
                Some(Lag::new(name, current, latest.trim_end_matches(')')))
            }
            _ => None,
        }
    })
    .collect()
}

#[derive(Deserialize)]
struct Outdated {
    current: Option<String>,
    latest: Option<String>,
}

pub(super) fn parse_pnpm(text: &str) -> Result<Vec<Lag>> {
    let packages: BTreeMap<String, Outdated> = serde_json::from_str(text)?;
    let known = packages.iter().filter_map(|(name, package)| {
        let (current, latest) = (package.current.as_ref()?, package.latest.as_ref()?);
        Some(Lag::new(name, current, latest))
    });
    Ok(known.filter(|lag| lag.current != lag.latest).collect())
}

/// Every Rust workspace's lag, one row per crate version.
pub(super) fn cargo() -> Result<Vec<Lag>> {
    let mut lags = BTreeSet::new();
    for manifest in crate::layers::WORKSPACES {
        let mut command = Command::new("cargo");
        command.args(["update", "--dry-run", "--verbose"]);
        if let Some(path) = manifest {
            command.args(["--manifest-path", path]);
        }
        let output = command.output()?;
        if !output.status.success() {
            return Err(format!("cargo update --dry-run failed on {manifest:?}").into());
        }
        lags.extend(parse_cargo(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(lags.into_iter().collect())
}

/// `pnpm outdated` exits 1 when anything is outdated, so its output decides, not its status.
pub(super) fn pnpm() -> Result<Vec<Lag>> {
    let output = Command::new("pnpm")
        .args(["outdated", "-r", "--format", "json"])
        .output()?;
    parse_pnpm(&String::from_utf8_lossy(&output.stdout))
        .map_err(|error| format!("pnpm outdated: {error}").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_cargo_prints() {
        let text = "    Updating crates.io index\n     Locking 2 packages\n      Adding x v1.0.0\n    \
                    Updating uuid v1.28.0 -> v1.29.0\n   Unchanged rand v0.8.5 (available: v0.9.0)\n\
                    note: to see how you depend on a package, run `cargo tree`\n";
        assert_eq!(
            parse_cargo(text),
            [
                Lag::new("uuid", "1.28.0", "1.29.0"),
                Lag::new("rand", "0.8.5", "0.9.0"),
            ]
        );
    }

    #[test]
    fn reads_what_pnpm_prints_and_refuses_anything_else() {
        let text = r#"{"jose":{"current":"6.2.13","latest":"6.2.14","wanted":"6.2.13"},
                       "unbuilt":{"latest":"1.0.0"},
                       "same":{"current":"1.0.0","latest":"1.0.0"}}"#;
        assert_eq!(
            parse_pnpm(text).unwrap(),
            [Lag::new("jose", "6.2.13", "6.2.14")]
        );
        assert!(parse_pnpm("ERR_PNPM_NO_REGISTRY").is_err());
    }

    #[test]
    fn breaking_means_the_first_nonzero_number_moved() {
        let breaking = |old, new| Lag::new("a", old, new).is_breaking();
        assert!(breaking("1.9.0", "2.0.0"));
        assert!(breaking("0.8.5", "0.9.0"));
        assert!(breaking("0.0.3", "0.0.4"));
        assert!(breaking("1.0.0-rc.1", "2.0.0"));
        assert!(!breaking("1.2.0", "1.3.0"));
        assert!(!breaking("0.8.5", "0.8.6"));
    }
}
