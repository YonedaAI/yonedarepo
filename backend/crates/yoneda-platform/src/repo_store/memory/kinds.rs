//! Memory kinds. Eight are built in, and any other short word is a kind too: the first memory
//! to use it adds it, and the repository offers it from then on (`offered`, read from the
//! memories themselves). The column takes any text, so this is the only check. A kind is
//! untrusted text that agents read in their context: it is normalized to one lowercase word
//! and nothing else is ever stored, and no credential the scanner knows fits in one.
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use yoneda_core::Result;

pub const KINDS: [&str; 8] = [
    "decision",
    "constraint",
    "gotcha",
    "howto",
    "convention",
    "risk",
    "fact",
    "preference",
];
/// What a purged memory's added kind becomes: the word was free text like its body.
const PURGED: &str = "decision";
const MAX_LEN: usize = 24;
/// Kinds a repository can add to the built-in ones: the picker stays a picker, and a writer
/// can't grow every list answer without bound.
pub const MAX_ADDED: usize = 32;
const SHAPE: &str = "Kinds are up to 24 letters, digits or hyphens, starting with a letter";

/// `text` as a kind: words joined by single hyphens, in lowercase, spelled as a built-in kind
/// when it is one (`How To` is `howto`).
pub(super) fn normalize(text: &str) -> Result<String> {
    let parts: Vec<&str> = text.trim().split([' ', '-', '_']).collect();
    let stray =
        parts.first().is_some_and(|p| p.is_empty()) || parts.last().is_some_and(|p| p.is_empty());
    let word = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("-")
        .to_ascii_lowercase();
    let shaped = !stray
        && word.len() <= MAX_LEN
        && word.starts_with(|c: char| c.is_ascii_lowercase())
        && word
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !shaped {
        return Err(bad(SHAPE));
    }
    let bare = word.replace('-', "");
    Ok(KINDS
        .iter()
        .find(|k| **k == bare)
        .map_or(word, |k| (*k).to_owned()))
}

/// The kinds this repository added by version `at`, in order.
fn added<S: SqlStore>(db: &S, at: u64) -> Result<Vec<String>> {
    let rows = db.query(
        "SELECT DISTINCT kind FROM memories WHERE recorded_version<=? ORDER BY 1",
        &[json!(at)],
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| row["kind"].as_str())
        .filter(|kind| !KINDS.contains(kind))
        .map(str::to_owned)
        .collect())
}

/// Refuses `kind` when it would be one added kind too many.
pub(super) fn allow<S: SqlStore>(db: &S, kind: &str, at: u64) -> Result<()> {
    if KINDS.contains(&kind) {
        return Ok(());
    }
    let added = added(db, at)?;
    if added.len() >= MAX_ADDED && !added.iter().any(|known| known == kind) {
        return Err(bad(&format!(
            "This repository has {MAX_ADDED} added kinds: use one of them"
        )));
    }
    Ok(())
}

/// The kinds a writer can pick from as of version `at`: the built-in ones, then the added.
pub(super) fn offered<S: SqlStore>(db: &S, at: u64) -> Result<Value> {
    let mut kinds: Vec<String> = KINDS.iter().map(|k| (*k).to_owned()).collect();
    kinds.extend(added(db, at)?);
    Ok(json!(kinds))
}

/// `SET` terms that clear what a purged memory said in its own words, and their bindings.
pub(in crate::repo_store) fn purged() -> (&'static str, [Value; 2]) {
    (
        "body='',kind=CASE WHEN kind IN (SELECT value FROM json_each(?)) THEN kind ELSE ? END",
        [json!(json!(KINDS).to_string()), json!(PURGED)],
    )
}
