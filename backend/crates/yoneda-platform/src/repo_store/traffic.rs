//! Traffic: where open Landings are, in the repository's files. A Landing's footprint is what it
//! writes (the files its own commits changed, with the symbols the deriver found there) and what
//! it read (its head's declared reads, the set landing itself checks). Nothing here decides
//! anything or moves anything: CTC warns a session (`warnings`), orders Landings (`queue`) and
//! shows them (`radar`), and separation (`land_when_cleared::separation`) holds on what it reads.
//!
//! A Landing's own commits are its first parents down to the first commit on its base: a merge
//! counts as the files it changed against its first parent, so a branch that merged its base in
//! also shows what that brought. The walk stops at `WALK` commits.
//!
//! Each footprint read is three statements however many Landings it covers (`read`): every count
//! here is bounded by the Landings named and the commits of each, never by the base's history.
use super::quarantine::WithheldMemories;
use super::rows;
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use yoneda_core::{
    Result,
    txlog::{Access, overlaps},
};
mod queue;
mod warnings;
pub(super) use queue::Queue;
pub(super) use warnings::{Ask, delivered_key, warnings};

/// Open Landings looked at, newest first.
const MAX_LANDINGS: u64 = 50;
/// Commits of one Landing looked at, from its head.
const WALK: u64 = 32;
/// Rows one footprint read keeps. Past it a Landing shows less, which only warns less.
const MAX_ROWS: u64 = 5000;

/// A commit is on `w.base` when it is the base's head, on its first-parent chain, or landed on
/// it. The head is asked first because a base that has not moved since chains began has none.
const ON_BASE: &str = "(w.id=(SELECT commit_id FROM refs WHERE name=w.base) \
     OR EXISTS (SELECT 1 FROM ref_chain b WHERE b.ref=w.base AND b.commit_id=w.id) \
     OR EXISTS (SELECT 1 FROM landings l WHERE l.commit_id=w.id AND l.refname=w.base))";

/// Where to start, and what to stop at.
#[derive(Debug, Clone)]
pub(super) struct Seed {
    pub landing: i64,
    pub head: String,
    /// The full ref name of its base.
    pub base: String,
}

/// An open Landing, as a warning or the radar names it.
pub(super) struct OpenLanding {
    pub seed: Seed,
    pub title: Value,
    pub branch: String,
    pub author: Value,
}

/// The newest open Landings that still have a branch, and whether there were more.
pub(super) fn open<S: SqlStore>(db: &S, limit: u64) -> Result<(Vec<OpenLanding>, bool)> {
    let rows = db.query(
        "SELECT c.number,c.title,c.branch,c.base,c.author,r.commit_id AS head FROM changes c \
         JOIN refs r ON r.name='refs/heads/'||c.branch WHERE c.status='open' \
         ORDER BY c.number DESC LIMIT ?",
        &[json!(limit + 1)],
    )?;
    let more = rows.len() as u64 > limit;
    let landings = rows
        .into_iter()
        .take(limit as usize)
        .map(|row| OpenLanding {
            seed: Seed {
                landing: row["number"].as_i64().unwrap_or_default(),
                head: row["head"].as_str().unwrap_or_default().to_owned(),
                base: format!("refs/heads/{}", row["base"].as_str().unwrap_or_default()),
            },
            branch: row["branch"].as_str().unwrap_or_default().to_owned(),
            title: row["title"].clone(),
            author: row["author"].clone(),
        })
        .collect();
    Ok((landings, more))
}

/// Which paths a read keeps: `None` keeps all.
#[derive(Debug, Default)]
pub(super) struct Wanted {
    pub files: BTreeSet<String>,
    /// `dir/` prefixes.
    pub dirs: BTreeSet<String>,
}

impl Wanted {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.dirs.is_empty()
    }

    /// Whether a Landing's read of `read` (a file or `dir/`) meets what is wanted.
    fn meets(&self, read: &str) -> bool {
        self.files.iter().chain(&self.dirs).any(|w| overlaps(read, w))
    }

    /// The bound parameters: the exact entries, with each file's directories, since a read of
    /// `src/` meets `src/net.rs`, and the prefixes.
    fn params(&self) -> (Value, Value) {
        let mut exact = self.files.clone();
        for file in &self.files {
            exact.extend(file.match_indices('/').map(|(at, _)| file[..=at].to_owned()));
        }
        (json!(exact).to_string().into(), json!(self.dirs).to_string().into())
    }
}

/// What one Landing is doing.
#[derive(Debug, Default)]
pub(super) struct Footprint {
    /// Each file it changed, with the symbols found changed there (none when not derived).
    pub writes: BTreeMap<String, BTreeSet<String>>,
    /// Its head's declared reads, at file or directory level.
    pub reads: BTreeSet<String>,
}

impl Footprint {
    /// What it read, as landing's batch rule counts it: with none declared, its writes.
    fn counted_reads(&self) -> BTreeSet<&str> {
        if self.reads.is_empty() {
            self.writes.keys().map(String::as_str).collect()
        } else {
            self.reads.iter().map(String::as_str).collect()
        }
    }

    /// The paths where one of the two wrote what the other read.
    pub fn read_conflict(&self, other: &Self) -> BTreeSet<String> {
        fn meeting(writes: &Footprint, reads: &Footprint) -> Vec<String> {
            let reads = reads.counted_reads();
            (writes.writes.keys())
                .filter(|path| reads.iter().any(|read| overlaps(path, read)))
                .cloned()
                .collect()
        }
        let mut paths = meeting(self, other);
        paths.extend(meeting(other, self));
        paths.into_iter().collect()
    }
}

/// The first parents of each seed down to its base: `(landing, commit)`.
fn walked<S: SqlStore>(db: &S, seeds: &[Seed]) -> Result<Vec<(i64, String)>> {
    let list: Vec<Value> = (seeds.iter())
        .map(|s| json!([s.landing, s.head, s.base]))
        .collect();
    let rows = db.query(
        &format!(
            "WITH RECURSIVE seed(landing,head,base) AS (SELECT json_extract(value,'$[0]'),\
             json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?1)),\
             walk(landing,id,base,n) AS (SELECT landing,head,base,0 FROM seed UNION ALL \
             SELECT w.landing,json_extract(c.parents,'$[0]'),w.base,w.n+1 \
             FROM walk w JOIN commits c ON c.id=w.id \
             WHERE w.n+1<?2 AND json_array_length(c.parents)>0 AND NOT {ON_BASE}) \
             SELECT w.landing,w.id FROM walk w WHERE NOT {ON_BASE}"
        ),
        &[json!(json!(list).to_string()), json!(WALK)],
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| Some((row["landing"].as_i64()?, row["id"].as_str()?.to_owned())))
        .collect())
}

/// The files `commits` changed, with the symbols derived there and the blobs on either side.
fn changed<S: SqlStore>(db: &S, commits: &[String], wanted: Option<&Wanted>) -> Result<Vec<Value>> {
    let (exact, dirs) = wanted.map_or((Value::Null, json!("[]")), Wanted::params);
    db.query(
        "SELECT p.commit_id,p.path,p.old_blob,p.new_blob,s.symbols FROM commit_paths p \
         LEFT JOIN commit_symbols s ON s.commit_id=p.commit_id AND s.path=p.path \
         WHERE p.commit_id IN (SELECT value FROM json_each(?1)) AND (?2 IS NULL \
         OR p.path IN (SELECT value FROM json_each(?2)) \
         OR EXISTS (SELECT 1 FROM json_each(?3) d WHERE substr(p.path,1,length(d.value))=d.value)) \
         LIMIT ?4",
        &[json!(json!(commits).to_string()), exact, dirs, json!(MAX_ROWS)],
    )
}

/// The declared reads of each head that meet `wanted`, as `(head, file or dir/)`. Only heads:
/// landing checks a head's reads and no others, and one head may declare 64 KiB of them, so the
/// matching stays in SQL. A symbol's read counts as its file.
fn declared<S: SqlStore>(
    db: &S,
    heads: &[&str],
    wanted: Option<&Wanted>,
) -> Result<Vec<(String, String)>> {
    let (exact, dirs) = wanted.map_or((Value::Null, json!("[]")), Wanted::params);
    const FILE: &str = "CASE WHEN instr(r.value,'#')>0 \
         THEN substr(r.value,1,instr(r.value,'#')-1) ELSE r.value END";
    let rows = db.query(
        &format!(
            "SELECT c.id,r.value AS entry FROM commits c,json_each(c.read_set) r \
             WHERE c.id IN (SELECT value FROM json_each(?1)) AND (?2 IS NULL \
             OR {FILE} IN (SELECT value FROM json_each(?2)) \
             OR EXISTS (SELECT 1 FROM json_each(?3) d \
             WHERE substr(r.value,1,length(d.value))=d.value)) LIMIT ?4"
        ),
        &[json!(json!(heads).to_string()), exact, dirs, json!(MAX_ROWS)],
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let entry = Access::parse(row["entry"].as_str()?);
            let meets = wanted.is_none_or(|w| w.meets(entry.path()));
            meets.then(|| (row["id"].as_str().unwrap_or_default().to_owned(), entry.path().to_owned()))
        })
        .collect())
}

/// The footprint of each seed, limited to `wanted`. A file whose blob quarantine withholds is
/// left out on either side, with the symbols that were derived from it.
pub(super) fn read<S: SqlStore>(
    db: &S,
    seeds: &[Seed],
    wanted: Option<&Wanted>,
) -> Result<BTreeMap<i64, Footprint>> {
    let mut prints: BTreeMap<i64, Footprint> = BTreeMap::new();
    if seeds.is_empty() {
        return Ok(prints);
    }
    let walk = walked(db, seeds)?;
    let mut holders: BTreeMap<&str, Vec<i64>> = BTreeMap::new();
    for (landing, commit) in &walk {
        holders.entry(commit).or_default().push(*landing);
    }
    let commits: Vec<String> = holders.keys().map(|c| (*c).to_owned()).collect();
    let rows = changed(db, &commits, wanted)?;
    if !rows.is_empty() {
        let withheld = WithheldMemories::read(db)?;
        for row in rows {
            let blobs = ["old_blob", "new_blob"].map(|side| row[side].as_str().unwrap_or_default());
            if withheld.masks(None, blobs.into_iter()) {
                continue;
            }
            let path = row["path"].as_str().unwrap_or_default();
            let symbols: Vec<String> = match row["symbols"].as_str() {
                Some(text) => serde_json::from_str(text).map_err(|_| rows::corrupt("symbols"))?,
                None => Vec::new(),
            };
            let commit = row["commit_id"].as_str().unwrap_or_default();
            for landing in holders.get(commit).into_iter().flatten() {
                let print = prints.entry(*landing).or_default();
                let files = print.writes.entry(path.to_owned()).or_default();
                files.extend(symbols.iter().cloned());
            }
        }
    }
    let heads: Vec<&str> = seeds.iter().map(|s| s.head.as_str()).collect();
    for (head, entry) in declared(db, &heads, wanted)? {
        for seed in seeds.iter().filter(|s| s.head == head) {
            prints.entry(seed.landing).or_default().reads.insert(entry.clone());
        }
    }
    Ok(prints)
}
