//! The bounded candidate sets a ranking scores: memories anchored on the requested files,
//! their directories or under requested directories, memories whose text matches a query
//! term (`memory_text`, full-text), and with `fill` the newest ones (each source at most
//! `PER_SOURCE`); each symbol's newest contract record (those on requested files first);
//! the newest `RECENT` session records and open changes. Memories and contracts are read
//! as of the request's log version; session records and changes as they are now.
use super::anchors::Anchor;
use super::records;
use super::relevance::Request;
use super::stale::Staleness;
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};
use yoneda_core::Result;

const PER_SOURCE: u64 = 200;
const FILL: u64 = 50;
const RECENT: u64 = 50;
/// Files read per session or change head when matching their commits' paths.
const COMMIT_PATHS: u64 = 5000;

pub struct Candidate {
    pub kind: &'static str,
    pub id: i64,
    pub score: u32,
    pub stale: Option<bool>,
    pub at: i64,
    pub text: String,
    pub value: Value,
}

impl Candidate {
    pub fn json(self) -> Value {
        json!({ "type": self.kind, "id": self.id, "score": self.score, "stale": self.stale,
                "at": self.at, "text": self.text, self.kind: self.value })
    }
}

fn ids(rows: Vec<Value>, key: &str) -> impl Iterator<Item = i64> {
    rows.into_iter().filter_map(move |r| r[key].as_i64())
}

/// Every `dir/` holding one of `files`.
fn ancestors(files: &BTreeSet<String>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for file in files {
        for (at, _) in file.match_indices('/') {
            out.insert(file[..=at].to_owned());
        }
    }
    out
}

pub fn gather<S: SqlStore>(db: &S, req: &Request) -> Result<Vec<Candidate>> {
    let mut out = Vec::new();
    if req.types.contains("memory") {
        memories(db, req, &mut out)?;
    }
    if req.types.contains("contract") {
        contracts(db, req, &mut out)?;
    }
    if req.types.contains("session") {
        sessions(db, req, &mut out)?;
    }
    if req.types.contains("change") {
        changes(db, req, &mut out)?;
    }
    Ok(out)
}

fn memories<S: SqlStore>(db: &S, req: &Request, out: &mut Vec<Candidate>) -> Result<()> {
    let mut found = BTreeSet::new();
    let keys: BTreeSet<String> = req.files.union(&ancestors(&req.files)).cloned().collect();
    if !keys.is_empty() {
        found.extend(ids(
            db.query(
                "SELECT DISTINCT memory_id FROM memory_anchors \
                 WHERE path IN (SELECT value FROM json_each(?)) ORDER BY memory_id DESC LIMIT ?",
                &[json!(json!(keys).to_string()), json!(PER_SOURCE)],
            )?,
            "memory_id",
        ));
    }
    if !req.dirs.is_empty() {
        found.extend(ids(
            db.query(
                "SELECT DISTINCT a.memory_id FROM memory_anchors a, json_each(?) d \
                 WHERE substr(a.path,1,length(d.value))=d.value ORDER BY a.memory_id DESC LIMIT ?",
                &[json!(json!(req.dirs).to_string()), json!(PER_SOURCE)],
            )?,
            "memory_id",
        ));
    }
    if !req.terms.is_empty() {
        // Terms are letters and digits only, quoted so none reads as an FTS operator.
        let query: Vec<String> = req.terms.iter().map(|t| format!("\"{t}\"")).collect();
        found.extend(ids(
            db.query(
                "SELECT rowid AS id FROM memory_text WHERE memory_text MATCH ? \
                 ORDER BY rowid DESC LIMIT ?",
                &[json!(query.join(" OR ")), json!(PER_SOURCE)],
            )?,
            "id",
        ));
    }
    if req.fill {
        found.extend(ids(
            db.query(
                "SELECT id FROM memories WHERE draft=0 ORDER BY id DESC LIMIT ?",
                &[json!(FILL)],
            )?,
            "id",
        ));
    }
    let found: Vec<i64> = found.into_iter().collect();
    let mut scored: Vec<(u32, Value, Vec<Anchor>)> = records::load(db, &found, req.at)?
        .into_iter()
        .filter(|(row, _)| records::status(row) == "active")
        .map(|(row, anchors)| {
            let place = anchors
                .iter()
                .map(|a| req.place(&a.path, &a.symbol_path))
                .max()
                .unwrap_or(0);
            let score = place + req.text(row["body"].as_str().unwrap_or_default());
            (score, row, anchors)
        })
        .filter(|(score, ..)| *score > 0 || req.fill)
        .collect();
    // Staleness (a few log reads each) only for the memories that can still place.
    scored.sort_by_key(|(score, row, _)| (Reverse(*score), Reverse(row["id"].as_i64())));
    scored.truncate(req.limit * 4);
    let mut check = Staleness::new(db, &req.refname, req.at);
    for (score, row, anchors) in scored {
        let memory = records::memory_json(&row, &anchors, Some(&mut check))?;
        out.push(Candidate {
            kind: "memory",
            id: row["id"].as_i64().unwrap_or_default(),
            score,
            stale: memory["stale"].as_bool(),
            at: row["recorded_at"].as_i64().unwrap_or_default(),
            text: row["body"].as_str().unwrap_or_default().to_owned(),
            value: memory,
        });
    }
    Ok(())
}

fn contracts<S: SqlStore>(db: &S, req: &Request, out: &mut Vec<Candidate>) -> Result<()> {
    let rows = db.query(
        "SELECT seq,path,symbol_path,commit_id,node_digest,contract,recorded_by,recorded_at \
         FROM symbol_contracts WHERE seq IN (SELECT MAX(seq) FROM symbol_contracts \
         WHERE recorded_version<=? GROUP BY path,symbol_path) \
         ORDER BY path IN (SELECT value FROM json_each(?)) DESC, seq DESC LIMIT ?",
        &[
            json!(req.at),
            json!(json!(req.files).to_string()),
            json!(PER_SOURCE),
        ],
    )?;
    for row in rows {
        let (path, symbol) = (
            row["path"].as_str().unwrap_or_default(),
            row["symbol_path"].as_str().unwrap_or_default(),
        );
        let contract: Value =
            serde_json::from_str(row["contract"].as_str().unwrap_or_default()).unwrap_or_default();
        let text = contract["summary"]
            .as_str()
            .map_or_else(|| contract.to_string(), str::to_owned);
        let score = req.place(path, symbol) + req.text(&format!("{symbol} {text}"));
        out.push(Candidate {
            kind: "contract",
            id: row["seq"].as_i64().unwrap_or_default(),
            score,
            stale: None,
            at: row["recorded_at"].as_i64().unwrap_or_default(),
            text,
            value: json!({ "path": path, "symbol_path": symbol, "commit": row["commit_id"],
                "node_digest": row["node_digest"], "contract": contract,
                "recorded_by": row["recorded_by"] }),
        });
    }
    Ok(())
}

/// The files each of `commits` changed.
fn changed<S: SqlStore>(db: &S, commits: &[&Value]) -> Result<BTreeMap<String, Vec<String>>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in db.query(
        "SELECT commit_id,path FROM commit_paths WHERE commit_id IN (SELECT value FROM json_each(?)) LIMIT ?",
        &[json!(json!(commits).to_string()), json!(COMMIT_PATHS)],
    )? {
        if let (Some(commit), Some(path)) = (row["commit_id"].as_str(), row["path"].as_str()) {
            out.entry(commit.to_owned())
                .or_default()
                .push(path.to_owned());
        }
    }
    Ok(out)
}

fn place_of(req: &Request, paths: Option<&Vec<String>>) -> u32 {
    paths
        .into_iter()
        .flatten()
        .map(|p| req.place(p, ""))
        .max()
        .unwrap_or(0)
}

fn sessions<S: SqlStore>(db: &S, req: &Request, out: &mut Vec<Candidate>) -> Result<()> {
    let rows = db.query(
        "SELECT s.id,s.commit_id,s.cli,s.model,s.summary,s.session_id,s.at,c.message \
         FROM sessions s JOIN commits c ON c.id=s.commit_id ORDER BY s.id DESC LIMIT ?",
        &[json!(RECENT)],
    )?;
    let commits: Vec<&Value> = rows.iter().map(|r| &r["commit_id"]).collect();
    let paths = changed(db, &commits)?;
    for row in &rows {
        let summary = row["summary"].as_str().unwrap_or_default();
        let subject = row["message"]
            .as_str()
            .unwrap_or_default()
            .lines()
            .next()
            .unwrap_or_default();
        let files = paths.get(row["commit_id"].as_str().unwrap_or_default());
        let score = place_of(req, files) + req.text(&format!("{subject} {summary}"));
        out.push(Candidate {
            kind: "session",
            id: row["id"].as_i64().unwrap_or_default(),
            score,
            stale: None,
            at: row["at"].as_i64().unwrap_or_default(),
            text: summary.to_owned(),
            value: json!({ "commit": row["commit_id"], "cli": row["cli"],
                "model": super::super::sessions::shown_model(&row["model"]),
                "session_id": row["session_id"], "subject": subject }),
        });
    }
    Ok(())
}

fn changes<S: SqlStore>(db: &S, req: &Request, out: &mut Vec<Candidate>) -> Result<()> {
    let rows = db.query(
        "SELECT number,title,body,branch,author,updated_at,\
         (SELECT commit_id FROM refs WHERE name='refs/heads/'||branch) AS head \
         FROM changes WHERE status='open' ORDER BY number DESC LIMIT ?",
        &[json!(RECENT)],
    )?;
    let heads: Vec<&Value> = rows.iter().map(|r| &r["head"]).collect();
    let paths = changed(db, &heads)?;
    for row in &rows {
        let title = row["title"].as_str().unwrap_or_default();
        let body = row["body"].as_str().unwrap_or_default();
        let files = paths.get(row["head"].as_str().unwrap_or_default());
        let score = place_of(req, files) + req.text(&format!("{title} {body}"));
        out.push(Candidate {
            kind: "change",
            id: row["number"].as_i64().unwrap_or_default(),
            score,
            stale: None,
            at: row["updated_at"].as_i64().unwrap_or_default(),
            text: title.to_owned(),
            value: json!({ "number": row["number"], "branch": row["branch"],
                "head": row["head"], "author": row["author"] }),
        });
    }
    Ok(())
}
