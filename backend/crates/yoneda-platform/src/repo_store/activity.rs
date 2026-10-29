//! The repository's activity for the account Home, read by the platform after a ref moved
//! or a session was recorded and projected to D1, so the page reads one D1 row per
//! repository instead of waking each authority. Every timed list starts at `since`; the
//! totals and the newest sessions do not.
use super::agent_reads::session;
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use yoneda_core::Result;

const HOUR_MS: i64 = 3_600_000;
/// The newest session records carried (the Home lists a handful across repositories).
const SESSIONS: i64 = 10;
/// Landing times of changes carried; a busier month only shows this many.
const CHANGES: i64 = 500;
/// A session row as `agent_reads::session` reads it, without its transcript (the Home
/// shows the summary; transcripts stay on the session page).
const COLUMNS: &str = "s.id,s.commit_id,s.cli,s.model,s.summary,s.prompt_digest,\
    s.transcript_ref,s.read_set_digest,s.recorded_by,s.at,s.session_id,NULL AS transcript,\
    c.message,c.read_set";

/// `repo_activity {since}`: `commits` as `[hour start (ms), count]` of commits made or
/// pushed at or after `since`, the newest `sessions`, `last_session_at`, the
/// landing times of changes landed since then, `commits_total`, `changes_landed_total`, and
/// `pushed`: whether anything but an import ever landed.
pub fn activity<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let since = c["since"]
        .as_i64()
        .ok_or_else(|| bad("since must be a time in milliseconds"))?;
    // Commits made on the platform or pushed with Git, when they were recorded (imported
    // history and fork copies are not new work). Changesets are commits a shard recorded
    // and landed before they were adopted here; a commit counts once.
    let first = "SELECT commit_id, MIN(at) AS at FROM (\
         SELECT id AS commit_id, recorded_at AS at FROM commits \
         WHERE origin IN ('platform','push') \
         UNION ALL SELECT commit_id, COALESCE(recorded_at, landed_at) FROM changesets) \
         GROUP BY commit_id";
    let commits = db
        .query(
            &format!(
                "SELECT (at / {HOUR_MS}) * {HOUR_MS} AS hour, COUNT(*) AS n FROM ({first}) \
                 WHERE at >= ? GROUP BY hour ORDER BY hour"
            ),
            &[json!(since)],
        )?
        .iter()
        .map(|r| json!([r["hour"], r["n"]]))
        .collect::<Vec<_>>();
    let commits_total = &db.query(&format!("SELECT COUNT(*) AS n FROM ({first})"), &[])?[0]["n"];
    let sessions = db
        .query(
            &format!(
                "SELECT {COLUMNS} FROM sessions s JOIN commits c ON c.id=s.commit_id \
                 ORDER BY s.id DESC LIMIT {SESSIONS}"
            ),
            &[],
        )?
        .iter()
        .map(session)
        .collect::<Result<Vec<_>>>()?;
    let last_session_at = &db.query("SELECT MAX(at) AS at FROM sessions", &[])?[0]["at"];
    let changes_landed = db
        .query(
            &format!(
                "SELECT updated_at FROM changes WHERE status='landed' AND updated_at >= ? \
                 ORDER BY updated_at DESC LIMIT {CHANGES}"
            ),
            &[json!(since)],
        )?
        .iter()
        .map(|r| r["updated_at"].clone())
        .collect::<Vec<_>>();
    let changes_landed_total = &db.query(
        "SELECT COUNT(*) AS n FROM changes WHERE status='landed'",
        &[],
    )?[0]["n"];
    // Compacted segments hold versions past the first, so something landed after it.
    let pushed = !db
        .query(
            "SELECT 1 AS x FROM txlog WHERE json_extract(entry,'$.kind') <> 'import' \
             UNION ALL SELECT 1 FROM txlog_segments LIMIT 1",
            &[],
        )?
        .is_empty();
    Ok(json!({
        "since": since,
        "commits": commits,
        "commits_total": commits_total,
        "sessions": sessions,
        "last_session_at": last_session_at,
        "changes_landed": changes_landed,
        "changes_landed_total": changes_landed_total,
        "pushed": pushed,
    }))
}
