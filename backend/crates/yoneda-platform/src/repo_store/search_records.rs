//! `repo_search_records {query, groups?, limit?}`: the repository's records that hold a
//! query's words, beside the code search (the adapter's `git_grep`): commits (their
//! message, who recorded them, the paths they touched, or an id prefix), session records
//! (their summary and the reads their commit declared) and change requests (title and
//! description). No model is involved.
//!
//! Each group answers `{count, capped, results}`: every match up to `CANDIDATES` per source
//! is counted (`capped` once a source reaches it) and the best `limit` are listed. Words
//! are those of `memory::relevance::words`, all required. A result scores by where they
//! all appear (a commit: id prefix 16, subject 8, message 4, author 2, a touched path 1; a
//! session: summary 2, reads 1; a change: title 2, description 1), then newest first, then
//! by id, so the same records always answer the same.
//!
//! A path-restricted token finds only commits that touch its grant, by their text or by
//! a granted path, and sees only granted paths; sessions and changes describe whole
//! commits and branches, so its groups are null. A quarantined session record is never
//! found.
use super::auth::Actor;
use super::memory::relevance::words;
use super::sessions::shown_model;
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::collections::BTreeSet;
use yoneda_core::Result;

mod commits;

pub const GROUPS: [&str; 3] = ["commits", "sessions", "changes"];
const DEFAULT_LIMIT: u64 = 10;
const MAX_LIMIT: u64 = 50;
const MAX_QUERY: usize = 200;
const MAX_TERMS: usize = 8;
/// Matches read per source before ranking.
const CANDIDATES: usize = 1000;
/// Candidate commits a path-restricted token's search checks against its grant.
const RESTRICTED_CANDIDATES: usize = 200;
/// Paths (or reads) shown per result, the matching ones first.
const SHOWN: usize = 5;

struct Request {
    terms: Vec<String>,
    /// The FTS query: every term, each quoted so none reads as an operator.
    matching: String,
    /// A commit id prefix (7-40 lowercase hex digits).
    id_prefix: Option<String>,
    groups: BTreeSet<&'static str>,
    limit: usize,
}

impl Request {
    fn parse(c: &Value) -> Result<Self> {
        let query = c["query"].as_str().unwrap_or_default().trim();
        if !(2..=MAX_QUERY).contains(&query.chars().count()) {
            return Err(bad("query must be 2-200 characters"));
        }
        let terms: Vec<String> = words(query).into_iter().take(MAX_TERMS).collect();
        let matching = terms
            .iter()
            .map(|t| format!("\"{t}\""))
            .collect::<Vec<_>>()
            .join(" ");
        let id_prefix = (query.len() >= 7
            && query.len() <= 40
            && query
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then(|| query.to_owned());
        let groups = match &c["groups"] {
            Value::Null => GROUPS.into_iter().collect(),
            Value::Array(asked) if !asked.is_empty() => asked
                .iter()
                .map(|g| {
                    GROUPS
                        .into_iter()
                        .find(|known| g.as_str() == Some(known))
                        .ok_or_else(|| bad("groups lists commits, sessions and changes"))
                })
                .collect::<Result<_>>()?,
            _ => return Err(bad("groups lists commits, sessions and changes")),
        };
        let limit = match &c["limit"] {
            Value::Null => DEFAULT_LIMIT,
            v => v
                .as_u64()
                .filter(|n| (1..=MAX_LIMIT).contains(n))
                .ok_or_else(|| bad("limit must be 1-50"))?,
        };
        Ok(Self {
            terms,
            matching,
            id_prefix,
            groups,
            limit: limit as usize,
        })
    }

    /// Whether `text` holds every term (as the words `words` makes of it).
    fn holds(&self, text: &str) -> bool {
        let found: BTreeSet<String> = words(text).into_iter().collect();
        !self.terms.is_empty() && self.terms.iter().all(|t| found.contains(t))
    }

    /// Rows matching the terms in `table` (an FTS table joined as `t`), newest rowid first.
    fn matches<S: SqlStore>(&self, db: &S, sql: &str, cap: usize) -> Result<Vec<Value>> {
        if self.terms.is_empty() {
            return Ok(Vec::new());
        }
        db.query(sql, &[json!(self.matching), json!(cap)])
    }
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// A group of ranked results: `(score, newest, id)` orders them.
fn group(mut ranked: Vec<((u32, i64, i64), Value)>, capped: bool, limit: usize) -> Value {
    ranked.sort_by_key(|(key, _)| Reverse(*key));
    let count = ranked.len();
    let results: Vec<Value> = ranked
        .into_iter()
        .take(limit)
        .map(|(_, value)| value)
        .collect();
    json!({ "count": count, "capped": capped, "results": results })
}

/// `items` with those `hit` first, at most `SHOWN`.
fn shown(items: Vec<String>, hit: impl Fn(&str) -> bool) -> Vec<String> {
    let (mut first, rest): (Vec<String>, Vec<String>) = items.into_iter().partition(|p| hit(p));
    first.extend(rest);
    first.truncate(SHOWN);
    first
}

fn sessions<S: SqlStore>(db: &S, req: &Request) -> Result<Value> {
    let rows = req.matches(
        db,
        "SELECT s.id,s.commit_id,s.cli,s.model,s.summary,s.session_id,s.at,c.read_set \
         FROM session_text t JOIN sessions s ON s.id=t.rowid LEFT JOIN commits c ON c.id=s.commit_id \
         WHERE session_text MATCH ? AND s.id NOT IN (SELECT CAST(target_id AS INTEGER) FROM \
         quarantine WHERE target_kind='session' AND state<>'released') ORDER BY t.rowid DESC LIMIT ?",
        CANDIDATES,
    )?;
    let capped = rows.len() == CANDIDATES;
    let ranked = rows
        .into_iter()
        .map(|row| {
            let reads: Vec<String> =
                serde_json::from_str(text(&row, "read_set")).unwrap_or_default();
            let (in_summary, in_reads) = (
                req.holds(text(&row, "summary")),
                req.holds(&reads.join(" ")),
            );
            let matched: Vec<&str> = [("summary", in_summary), ("reads", in_reads)]
                .into_iter()
                .filter(|(_, hit)| *hit)
                .map(|(name, _)| name)
                .collect();
            let score = 2 * u32::from(in_summary) + u32::from(in_reads);
            let id = row["id"].as_i64().unwrap_or(0);
            let value = json!({
                "id": id, "commit": row["commit_id"], "cli": row["cli"],
                "model": shown_model(&row["model"]), "session_id": row["session_id"],
                "summary": row["summary"], "at": row["at"], "matched": matched,
                "reads": shown(reads, |p| req.holds(p)),
            });
            ((score, row["at"].as_i64().unwrap_or(0), id), value)
        })
        .collect();
    Ok(group(ranked, capped, req.limit))
}

fn changes<S: SqlStore>(db: &S, req: &Request) -> Result<Value> {
    let rows = req.matches(
        db,
        "SELECT c.number,c.title,c.body,c.status,c.branch,c.base,c.author,c.updated_at \
         FROM change_text t JOIN changes c ON c.number=t.rowid WHERE change_text MATCH ? \
         ORDER BY t.rowid DESC LIMIT ?",
        CANDIDATES,
    )?;
    let capped = rows.len() == CANDIDATES;
    let ranked = rows
        .into_iter()
        .map(|row| {
            let (in_title, in_body) = (
                req.holds(text(&row, "title")),
                req.holds(text(&row, "body")),
            );
            let matched: Vec<&str> = [("title", in_title), ("body", in_body)]
                .into_iter()
                .filter(|(_, hit)| *hit)
                .map(|(name, _)| name)
                .collect();
            let number = row["number"].as_i64().unwrap_or(0);
            let value = json!({
                "number": number, "title": row["title"], "status": row["status"],
                "branch": row["branch"], "base": row["base"], "author": row["author"],
                "updated_at": row["updated_at"], "matched": matched,
            });
            let score = 2 * u32::from(in_title) + u32::from(in_body);
            (
                (score, row["updated_at"].as_i64().unwrap_or(0), number),
                value,
            )
        })
        .collect();
    Ok(group(ranked, capped, req.limit))
}

/// `repo_search_records`: see the module header.
pub fn search<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let req = Request::parse(c)?;
    let whole = actor.grant.is_none();
    let wanted = |name: &str| req.groups.contains(name);
    Ok(json!({
        "query": c["query"].as_str().unwrap_or_default().trim(),
        "terms": req.terms,
        "commits": if wanted("commits") { commits::commits(db, &req, &actor.grant)? } else { Value::Null },
        "sessions": if wanted("sessions") && whole { sessions(db, &req)? } else { Value::Null },
        "changes": if wanted("changes") && whole { changes(db, &req)? } else { Value::Null },
    }))
}
