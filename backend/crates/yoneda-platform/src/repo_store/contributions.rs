//! A bounded page explaining the same recorded-commit buckets as account activity.
use super::{activity::FIRST_RECORDS, auth::Actor, git_http::whole_repository};
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use yoneda_core::Result;

const HOUR: i64 = 3_600_000;

/// The adapter supplies only server-held summary cutoffs after checking account access.
/// The authority independently checks whole-repository read access on every page.
pub fn contributions<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let natural = |value: &Value| {
        value
            .as_i64()
            .filter(|n| *n >= 0)
            .ok_or_else(|| bad("Invalid contribution boundary"))
    };
    let commits = natural(&c["snapshot"]["commits"])?;
    let changesets = natural(&c["snapshot"]["changesets"])?;
    let since = natural(&c["since"])?;
    let hours = c["hours"]
        .as_array()
        .filter(|h| !h.is_empty() && h.len() <= 2)
        .ok_or_else(|| bad("Select one or two UTC hours"))?;
    for hour in hours {
        if natural(hour)? % HOUR != 0 {
            return Err(bad("Select whole UTC hours"));
        }
    }
    let limit = c["limit"].as_u64().unwrap_or(25);
    if !(1..=50).contains(&limit) {
        return Err(bad("limit must be 1-50"));
    }
    let (after_at, after_commit) = if c["after"].is_null() {
        (-1, "")
    } else {
        let at = natural(&c["after"]["at"])?;
        let commit = c["after"]["commit"]
            .as_str()
            .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| bad("Invalid contribution cursor"))?;
        (at, commit)
    };
    let total = db.query(&format!("SELECT COUNT(*) AS n FROM ({FIRST_RECORDS}) WHERE at>=? AND (at / {HOUR}) * {HOUR} IN (SELECT value FROM json_each(?))"), &[json!(commits),json!(changesets),json!(since),json!(hours)])?[0]["n"].clone();
    let rows = db.query(
        &format!("WITH first AS ({FIRST_RECORDS}) \
            SELECT f.commit_id AS commit_id,f.at,COALESCE(c.message, \
              (SELECT message FROM changesets s WHERE s.commit_id=f.commit_id AND s.rowid<=? ORDER BY s.rowid LIMIT 1),'Commit') AS message \
            FROM first f LEFT JOIN commits c ON c.id=f.commit_id AND c.rowid<=? \
            WHERE f.at>=? AND (f.at / {HOUR}) * {HOUR} IN (SELECT value FROM json_each(?)) \
            AND (f.at>? OR (f.at=? AND f.commit_id>?)) ORDER BY f.at,f.commit_id LIMIT ?"),
        &[json!(commits),json!(changesets),json!(changesets),json!(commits),json!(since),json!(hours),json!(after_at),json!(after_at),json!(after_commit),json!(limit + 1)],
    )?;
    let shown = usize::try_from(limit).map_err(|_| bad("Invalid page size"))?;
    let items = rows.iter().take(shown).map(|r| json!({"commit":r["commit_id"],"at":r["at"],"subject":r["message"].as_str().unwrap_or_default().lines().next().unwrap_or_default()})).collect::<Vec<_>>();
    let next = if rows.len() > shown {
        items
            .last()
            .map(|r| json!({"at":r["at"],"commit":r["commit"]}))
    } else {
        None
    };
    Ok(json!({"items":items,"next":next,"total":total}))
}
