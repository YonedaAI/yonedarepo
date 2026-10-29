//! `repo_context_relevant`: one bounded, deterministic ranking of what a coding session
//! should be shown for the files and symbols it is working on and/or a short text (its
//! prompt): current memories, authored contracts (each symbol's newest record), the newest
//! session records (by the files their commits changed and their summaries) and open change
//! requests (by their head commit's files and their titles). No model is involved.
//!
//! Ranking: each item scores by where it is anchored (a requested symbol 8, a requested
//! file or another symbol in it 4, a directory holding a requested file or a file under a
//! requested directory 2, best anchor wins) plus 2 per distinct query term its text holds
//! (at most 3 terms). Items are ordered by score, then fresh before stale, then newest,
//! then memory, contract, session, change, then id. Items scoring 0 are left out, except
//! the newest current memories when `fill` asks for them (a session start). With a
//! `session_id`, items already delivered to that session by this caller are left out and
//! the bytes delivered so far are reported, so a client can keep its per-session cap.
use super::super::auth::Actor;
use super::anchors::anchor_path;
use super::candidates::{self, Candidate};
use super::records::{judged_ref, version_at};
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::collections::BTreeSet;
use yoneda_core::Result;

const MAX_PATHS: usize = 100;
const MAX_SYMBOLS: usize = 100;
const MAX_QUERY: usize = 2000;
const MAX_TERMS: usize = 16;
const DEFAULT_LIMIT: u64 = 10;
const MAX_LIMIT: u64 = 50;
pub const TYPES: [&str; 4] = ["memory", "contract", "session", "change"];
const STOPWORDS: [&str; 40] = [
    "the", "and", "for", "with", "this", "that", "from", "into", "what", "when", "where", "which",
    "have", "has", "are", "was", "were", "you", "your", "not", "but", "can", "should", "would",
    "could", "will", "please", "make", "need", "want", "all", "any", "its", "how", "why", "about",
    "then", "than", "they", "also",
];

/// What a ranking is asked for.
pub struct Request {
    /// Files and `dir/` prefixes, plus the files of the requested symbols.
    pub files: BTreeSet<String>,
    pub dirs: BTreeSet<String>,
    pub symbols: BTreeSet<(String, String)>,
    pub terms: Vec<String>,
    pub types: BTreeSet<&'static str>,
    pub fill: bool,
    pub limit: usize,
    pub at: u64,
    pub refname: String,
    pub session_id: Option<String>,
}

/// Lowercase words of at least 3 and at most 32 letters or digits, stopwords dropped.
pub fn words(text: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    text.split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|w| (3..=32).contains(&w.chars().count()) && !STOPWORDS.contains(&w.as_str()))
        .filter(|w| seen.insert(w.clone()))
        .collect()
}

fn list(c: &Value, key: &str, max: usize) -> Result<Vec<String>> {
    match &c[key] {
        Value::Null => Ok(Vec::new()),
        v => serde_json::from_value::<Vec<String>>(v.clone())
            .ok()
            .filter(|l| l.len() <= max)
            .ok_or_else(|| bad(&format!("{key} must be a list of at most {max}"))),
    }
}

impl Request {
    pub fn parse<S: SqlStore>(db: &S, c: &Value) -> Result<Self> {
        let (mut files, mut dirs, mut symbols) =
            (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
        for path in list(c, "paths", MAX_PATHS)? {
            anchor_path(&path)?;
            if path.ends_with('/') {
                dirs.insert(path);
            } else {
                files.insert(path);
            }
        }
        for symbol in list(c, "symbols", MAX_SYMBOLS)? {
            let (path, name) = symbol
                .split_once('#')
                .filter(|(_, n)| !n.is_empty() && n.len() <= 512)
                .ok_or_else(|| bad("symbols must be path#symbol_path"))?;
            yoneda_core::validate_path(path)?;
            files.insert(path.to_owned());
            symbols.insert((path.to_owned(), name.to_owned()));
        }
        let query = match &c["query"] {
            Value::Null => "",
            Value::String(q) if q.len() <= MAX_QUERY => q,
            _ => return Err(bad("query must be text of at most 2000 bytes")),
        };
        let mut terms = words(query);
        terms.truncate(MAX_TERMS);
        let types = match &c["types"] {
            Value::Null => TYPES.into_iter().collect(),
            v => {
                let named: Vec<String> =
                    serde_json::from_value(v.clone()).map_err(|_| bad("types must be a list"))?;
                named
                    .iter()
                    .map(|t| {
                        TYPES
                            .into_iter()
                            .find(|k| k == t)
                            .ok_or_else(|| bad("types are memory, contract, session and change"))
                    })
                    .collect::<Result<_>>()?
            }
        };
        let limit = match &c["limit"] {
            Value::Null => DEFAULT_LIMIT,
            v => v
                .as_u64()
                .filter(|n| (1..=MAX_LIMIT).contains(n))
                .ok_or_else(|| bad("limit must be 1-50"))?,
        };
        let session_id = match &c["session_id"] {
            Value::Null => None,
            Value::String(s) if !s.is_empty() && s.len() <= 128 => Some(s.clone()),
            _ => return Err(bad("session_id must be 1-128 characters")),
        };
        Ok(Self {
            files,
            dirs,
            symbols,
            terms,
            types,
            fill: c["fill"] == true,
            limit: limit as usize,
            at: version_at(db, c)?,
            refname: judged_ref(c)?,
            session_id,
        })
    }

    /// How closely an anchor at `path` (and `symbol`, empty for a whole file) meets the
    /// request.
    pub fn place(&self, path: &str, symbol: &str) -> u32 {
        if !symbol.is_empty() && self.symbols.contains(&(path.to_owned(), symbol.to_owned())) {
            8
        } else if self.files.contains(path) {
            4
        } else if (path.ends_with('/') && self.files.iter().any(|f| f.starts_with(path)))
            || self.dirs.iter().any(|d| path.starts_with(d.as_str()))
        {
            2
        } else {
            0
        }
    }

    /// 2 per distinct query term `text` holds, at most 3 terms.
    pub fn text(&self, text: &str) -> u32 {
        if self.terms.is_empty() {
            return 0;
        }
        let have: BTreeSet<String> = words(text).into_iter().collect();
        2 * self
            .terms
            .iter()
            .filter(|t| have.contains(*t))
            .count()
            .min(3) as u32
    }
}

fn type_order(kind: &str) -> usize {
    TYPES.iter().position(|t| *t == kind).unwrap_or(TYPES.len())
}

/// The ranked items for `req`, best first, at most `req.limit`.
pub fn rank<S: SqlStore>(db: &S, req: &Request, skip: &BTreeSet<String>) -> Result<Vec<Value>> {
    let mut items: Vec<Candidate> = candidates::gather(db, req)?
        .into_iter()
        .filter(|c| c.score > 0 || (req.fill && c.kind == "memory"))
        .filter(|c| !skip.contains(&format!("{}:{}", c.kind, c.id)))
        .collect();
    items.sort_by_key(|c| {
        (
            Reverse(c.score),
            c.stale == Some(true),
            Reverse(c.at),
            type_order(c.kind),
            Reverse(c.id),
        )
    });
    items.truncate(req.limit);
    Ok(items.into_iter().map(Candidate::json).collect())
}

/// `repo_context_relevant {paths?, symbols?, query?, types?, ref?, at?, fill?, limit?,
/// session_id?}`.
pub fn relevant<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let req = Request::parse(db, c)?;
    let delivered = match &req.session_id {
        Some(session) => Some(super::deliveries::delivered(db, session, &actor.principal)?),
        None => None,
    };
    let skip = delivered
        .as_ref()
        .map(|d| d.items.clone())
        .unwrap_or_default();
    Ok(json!({
        "version": req.at, "ref": req.refname, "terms": req.terms,
        "items": rank(db, &req, &skip)?,
        "delivered": delivered.map(|d| json!({ "bytes": d.bytes, "count": d.count })),
    }))
}

/// The current memories a session starting on `paths` should see, ranked, newest current
/// ones filling the rest (`repo_agent_context`).
pub fn for_start<S: SqlStore>(db: &S, paths: &[String], limit: u64) -> Result<Value> {
    let c = json!({ "paths": paths, "types": ["memory"], "fill": true, "limit": limit });
    let req = Request::parse(db, &c)?;
    Ok(json!(rank(db, &req, &BTreeSet::new())?))
}
