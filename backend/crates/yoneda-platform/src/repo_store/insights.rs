//! Who made a repository's recent commits, for its Insights page. The page's traffic figures
//! are kept outside the repository, so the platform serves them only after this answers: it is
//! where access is decided, and a reader limited to some paths reads nothing here.
use super::auth::Actor;
use super::git_http::whole_repository;
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use yoneda_core::Result;

/// The newest rows read from each table: the page's window never scans a long history.
const NEWEST: u32 = 5_000;
/// Contributors listed.
const SHOWN: usize = 25;

/// `repo_insights {since}`: `contributors`, each a `principal` and its `commits` made or pushed
/// at or after `since`, busiest first, and `more` when others are left out. Imported history
/// and fork copies are not new work; a commit a shard landed counts once, under its writer.
pub fn insights<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let since = c["since"]
        .as_i64()
        .ok_or_else(|| bad("since must be a time in milliseconds"))?;
    let rows = db.query(
        &format!(
            "SELECT who, COUNT(*) AS n FROM (\
             SELECT commit_id, MIN(who) AS who, MIN(at) AS at FROM (\
             SELECT * FROM (SELECT id AS commit_id, principal AS who, recorded_at AS at \
             FROM commits WHERE origin IN ('platform','push') ORDER BY rowid DESC LIMIT {NEWEST}) \
             UNION ALL SELECT * FROM (SELECT commit_id, writer, COALESCE(recorded_at, landed_at) \
             FROM changesets ORDER BY rowid DESC LIMIT {NEWEST})) \
             GROUP BY commit_id) \
             WHERE at >= ? AND who IS NOT NULL AND who NOT LIKE 'platform:%' \
             GROUP BY who ORDER BY n DESC, who LIMIT {}",
            SHOWN + 1
        ),
        &[json!(since)],
    )?;
    let contributors = rows
        .iter()
        .take(SHOWN)
        .map(|r| json!({ "principal": r["who"], "commits": r["n"] }))
        .collect::<Vec<_>>();
    Ok(json!({ "contributors": contributors, "more": rows.len() > SHOWN }))
}
