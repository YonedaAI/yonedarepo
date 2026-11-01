//! Catches `MIGRATION_DRIFT` before a deploy. A store refuses a binary whose migration text
//! differs from what the store applied (`repo_store/migration.rs`). `xtask/migrations.lock`
//! pins each applied migration's digest: text that differs from the ledger, a migration that
//! went away, or a new one not yet recorded all fail. Against `--base` the ledger itself is
//! append-only, so editing a migration and its line together fails too.
use super::{base, file_at};
use crate::process::Result;
use std::path::Path;
use yoneda_platform::applied_migrations;

const LEDGER: &str = "xtask/migrations.lock";
const HEADER: &str =
    "# Digests of applied migrations (`cargo xtask health migrations`). Append-only: add a
# line with `--record`, and never edit one. A differing digest is MIGRATION_DRIFT on a live store.
";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Entry {
    store: String,
    version: i64,
    digest: String,
}

impl Entry {
    fn name(&self) -> String {
        format!("{} {}", self.store, self.version)
    }
    fn same_migration(&self, other: &Entry) -> bool {
        self.store == other.store && self.version == other.version
    }
}

fn parse(text: &str) -> Result<Vec<Entry>> {
    let rows = text.lines().filter(|line| !line.starts_with('#'));
    rows.map(|line| {
        let words: Vec<&str> = line.split_whitespace().collect();
        match words[..] {
            [store, version, digest] => Ok(Entry {
                store: store.to_owned(),
                version: version.parse()?,
                digest: digest.to_owned(),
            }),
            _ => Err(format!("{LEDGER}: bad line {line:?}").into()),
        }
    })
    .collect()
}

fn render(entries: &[Entry]) -> String {
    let rows = entries.iter().map(|entry| {
        let Entry {
            store,
            version,
            digest,
        } = entry;
        format!("{store} {version} {digest}\n")
    });
    format!("{HEADER}{}", rows.collect::<String>())
}

fn in_code() -> Vec<Entry> {
    let applied = applied_migrations().into_iter();
    applied
        .map(|migration| Entry {
            store: migration.store.to_owned(),
            version: migration.version,
            digest: migration.digest,
        })
        .collect()
}

/// Changed and removed migrations: what a live store would refuse.
pub(super) fn drifted(ledger: &[Entry], code: &[Entry]) -> Vec<String> {
    let mut found = Vec::new();
    for entry in ledger {
        match code.iter().find(|other| other.same_migration(entry)) {
            None => found.push(format!("{}: recorded, now gone", entry.name())),
            Some(other) if other.digest != entry.digest => found.push(format!(
                "{}: text differs from the ledger; a store that applied it refuses this binary \
                 with MIGRATION_DRIFT. Add a new migration instead",
                entry.name()
            )),
            Some(_) => {}
        }
    }
    found
}

fn unrecorded<'a>(ledger: &[Entry], code: &'a [Entry]) -> Vec<&'a Entry> {
    let recorded = |entry: &&Entry| ledger.iter().any(|other| other.same_migration(entry));
    code.iter().filter(|entry| !recorded(entry)).collect()
}

/// Ledger lines changed or dropped since `base`.
fn rewritten(base: &[Entry], now: &[Entry]) -> Vec<String> {
    base.iter()
        .filter(|entry| !now.contains(entry))
        .map(|entry| format!("{LEDGER}: {} was changed: it's append-only", entry.name()))
        .collect()
}

fn read_ledger(root: &Path) -> Result<Vec<Entry>> {
    parse(&std::fs::read_to_string(root.join(LEDGER))?)
}

/// Every recorded migration still has its text, and every applied one is recorded.
pub(super) fn breaches(ledger: &[Entry], code: &[Entry]) -> Vec<String> {
    let mut found = drifted(ledger, code);
    found.extend(unrecorded(ledger, code).into_iter().map(|entry| {
        format!(
            "{}: not recorded: run `cargo xtask health migrations --record`",
            entry.name()
        )
    }));
    found
}

pub(super) fn current_breaches(root: &Path) -> Result<Vec<String>> {
    Ok(breaches(&read_ledger(root)?, &in_code()))
}

/// The gate. `commit`, when given, is the commit whose ledger this one must extend.
pub(crate) fn check(commit: Option<&str>) -> Result<()> {
    let root = std::env::current_dir()?;
    let ledger = read_ledger(&root)?;
    let mut errors = breaches(&ledger, &in_code());
    if let Some(commit) = commit
        && let Some(old) = file_at(&root, commit, LEDGER)?
    {
        errors.extend(rewritten(&parse(&old)?, &ledger));
    }
    if !errors.is_empty() {
        return Err(format!("Migration drift:\n  {}", errors.join("\n  ")).into());
    }
    println!("migrations: {} match {LEDGER}", ledger.len());
    Ok(())
}

pub(super) fn command(args: &[String]) -> Result<()> {
    if !args.iter().any(|arg| arg == "--record") {
        return check(base(args));
    }
    let root = std::env::current_dir()?;
    let mut ledger = read_ledger(&root)?;
    let code = in_code();
    let errors = drifted(&ledger, &code);
    if !errors.is_empty() {
        return Err(format!("Not recording over drift:\n  {}", errors.join("\n  ")).into());
    }
    let new: Vec<Entry> = unrecorded(&ledger, &code).into_iter().cloned().collect();
    println!("migrations: recorded {} new", new.len());
    ledger.extend(new);
    std::fs::write(root.join(LEDGER), render(&ledger))?;
    check(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(store: &str, version: i64, digest: &str) -> Entry {
        Entry {
            store: store.to_owned(),
            version,
            digest: digest.to_owned(),
        }
    }

    #[test]
    fn an_edited_migration_fails_like_a_live_store() {
        let found = breaches(
            &[entry("repo_store", 1, "old")],
            &[entry("repo_store", 1, "new")],
        );
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("repo_store 1"), "{found:?}");
        assert!(found[0].contains("MIGRATION_DRIFT"), "{found:?}");
    }

    #[test]
    fn the_same_version_of_another_store_is_another_migration() {
        let ledger = [entry("repo_store", 1, "a"), entry("accounts", 1, "b")];
        assert!(breaches(&ledger, &ledger).is_empty());
    }

    #[test]
    fn a_removed_migration_and_an_unrecorded_one_fail() {
        let found = breaches(&[entry("accounts", 1, "a")], &[entry("accounts", 2, "b")]);
        assert_eq!(
            found,
            [
                "accounts 1: recorded, now gone",
                "accounts 2: not recorded: run `cargo xtask health migrations --record`",
            ]
        );
    }

    #[test]
    fn against_the_base_the_ledger_only_grows() {
        let old = [entry("accounts", 1, "a")];
        let grown = [entry("accounts", 1, "a"), entry("accounts", 2, "b")];
        assert!(rewritten(&old, &grown).is_empty());
        assert_eq!(
            rewritten(&old, &[entry("accounts", 1, "edited")]),
            ["xtask/migrations.lock: accounts 1 was changed: it's append-only"]
        );
    }

    #[test]
    fn the_ledger_round_trips_and_a_bad_line_is_an_error() {
        let entries = [entry("accounts", 1, "a"), entry("repo_store", 44, "b")];
        assert_eq!(parse(&render(&entries)).unwrap(), entries);
        assert!(parse("accounts one\n").is_err());
    }

    #[test]
    fn the_committed_ledger_matches_this_binary() {
        let ledger = parse(include_str!("../../migrations.lock")).unwrap();
        assert_eq!(breaches(&ledger, &in_code()), Vec::<String>::new());
    }
}
