//! Traffic warnings, the one thing CTC tells a coding session: "Landing 5 is changing this file".
//! `repo_agent_context` asks when a session starts and `repo_context_relevant` when it reads a
//! file, both for the paths and symbols the session names, and the session's own branch says
//! the rest: its pushed work is what it is changing, and its own Landing is no traffic.
//!
//! One warning is one Landing on one path. They rank by overlap: the same symbol, then the same
//! file, then a Landing that read the file (changing it sends that one around); then newest.
//! `MOST` go out, at most `PER_LANDING` of each, with a count of the rest. Warnings are a separate
//! answer and not ranked items: an installed client renders any item it can't name as an open
//! change, and a session's delivered record says `traffic`, which only a platform that answered
//! one can have sent it.
use super::{MAX_LANDINGS, Footprint, Seed, Wanted, open, read};
use crate::repo_store::grants::{self, Grant};
use crate::repo_store::rows;
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};
use yoneda_core::{Result, txlog::symbols_overlap};

/// Warnings one read answers.
const MOST: usize = 8;
const PER_LANDING: usize = 3;
/// Symbols named per warning.
const SYMBOLS: usize = 5;
/// The base a session's branch is measured against.
const MAIN: &str = "refs/heads/main";

/// What a session asks about.
#[derive(Debug, Default)]
pub struct Ask {
    pub files: BTreeSet<String>,
    pub dirs: BTreeSet<String>,
    /// `(path, symbol)`.
    pub symbols: BTreeSet<(String, String)>,
    /// The session's branch: its Landing is left out and its symbols count as named.
    pub branch: Option<String>,
    /// All the branch changed is asked about too: a session starting has read nothing yet.
    pub start: bool,
}

/// How a Landing meets a session, closest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Overlap {
    Symbol,
    File,
    Read,
}

impl Overlap {
    fn name(self) -> &'static str {
        match self {
            Self::Symbol => "symbol",
            Self::File => "file",
            Self::Read => "read",
        }
    }
}

struct Warning {
    overlap: Overlap,
    landing: i64,
    path: String,
    symbols: Vec<String>,
}

/// The key a session's delivered record keeps a warning under (`memory::deliveries`).
pub(in crate::repo_store) fn delivered_key(landing: i64, path: &str) -> String {
    format!("traffic:{landing}:{path}")
}

/// The branch's own files and symbols, measured against main.
fn own<S: SqlStore>(db: &S, branch: &str) -> Result<Footprint> {
    let refname = format!("refs/heads/{branch}");
    let Some(head) = rows::projected_ref(db, &refname)?.filter(|_| refname != MAIN) else {
        return Ok(Footprint::default());
    };
    let seed = Seed {
        landing: 0,
        head: head.hex(),
        base: MAIN.to_owned(),
    };
    Ok(read(db, &[seed], None)?.remove(&0).unwrap_or_default())
}

/// The named symbols on `path` that `changed` meets.
fn met(named: &BTreeSet<(String, String)>, path: &str, changed: &BTreeSet<String>) -> Vec<String> {
    changed
        .iter()
        .filter(|symbol| {
            (named.iter()).any(|(file, name)| file == path && symbols_overlap(symbol, name))
        })
        .cloned()
        .collect()
}

fn of_landing(
    landing: i64,
    print: &Footprint,
    named: &BTreeSet<(String, String)>,
    grant: &Grant,
    out: &mut Vec<Warning>,
) {
    for (path, changed) in &print.writes {
        let same = met(named, path, changed);
        let (overlap, symbols) = if same.is_empty() {
            (Overlap::File, changed.iter().cloned().collect())
        } else {
            (Overlap::Symbol, same)
        };
        out.push(Warning {
            overlap,
            landing,
            path: path.clone(),
            symbols,
        });
    }
    let reads = (print.reads.iter()).filter(|read| !print.writes.contains_key(*read));
    out.extend(reads.map(|path| Warning {
        overlap: Overlap::Read,
        landing,
        path: path.clone(),
        symbols: Vec::new(),
    }));
    out.retain(|w| grants::allows(grant, &w.path));
}

/// The traffic on what `ask` names, leaving out what a session was already told (`told`, by
/// `delivered_key`). `{warnings, more}`: `more` counts what ranked too low to send.
pub fn warnings<S: SqlStore>(
    db: &S,
    ask: &Ask,
    grant: &Grant,
    told: &BTreeSet<String>,
) -> Result<Value> {
    let quiet = || json!({ "warnings": [], "more": 0 });
    let mut wanted = Wanted {
        files: ask.files.clone(),
        dirs: ask.dirs.clone(),
    };
    if wanted.is_empty() && !ask.start {
        return Ok(quiet());
    }
    let (landings, _) = open(db, MAX_LANDINGS)?;
    let mine = ask.branch.as_deref();
    let others: Vec<_> = (landings.iter())
        .filter(|l| Some(l.branch.as_str()) != mine)
        .collect();
    if others.is_empty() {
        return Ok(quiet());
    }
    let mut named = ask.symbols.clone();
    if let Some(branch) = mine {
        let print = own(db, branch)?;
        for (path, symbols) in print.writes {
            named.extend(symbols.into_iter().map(|s| (path.clone(), s)));
            if ask.start {
                wanted.files.insert(path);
            }
        }
    }
    if wanted.is_empty() {
        return Ok(quiet());
    }
    let seeds: Vec<Seed> = others.iter().map(|l| l.seed.clone()).collect();
    let mut ranked = Vec::new();
    for (landing, print) in &read(db, &seeds, Some(&wanted))? {
        of_landing(*landing, print, &named, grant, &mut ranked);
    }
    ranked.retain(|w| !told.contains(&delivered_key(w.landing, &w.path)));
    ranked.sort_by_key(|w| (w.overlap, Reverse(w.landing), w.path.clone()));
    let total = ranked.len();
    let mut per: BTreeMap<i64, usize> = BTreeMap::new();
    let sent: Vec<Value> = ranked
        .into_iter()
        .filter(|w| {
            let seen = per.entry(w.landing).or_default();
            *seen += 1;
            *seen <= PER_LANDING
        })
        .take(MOST)
        .map(|w| {
            let about = others.iter().find(|l| l.seed.landing == w.landing);
            let symbols: Vec<&String> = w.symbols.iter().take(SYMBOLS).collect();
            json!({
                "landing": w.landing, "overlap": w.overlap.name(), "path": w.path,
                "symbols": symbols, "title": about.map(|l| &l.title),
                "branch": about.map(|l| &l.branch), "author": about.map(|l| &l.author),
            })
        })
        .collect();
    Ok(json!({ "more": total - sent.len(), "warnings": sent }))
}
