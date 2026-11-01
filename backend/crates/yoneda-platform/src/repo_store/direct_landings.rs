//! Landings no change names: work pushed straight to `main`, as agents are told to. The
//! Landings list shows them beside its rows, as "Landed directly", from what the repository
//! already holds. `landings` has no order by time, so this reads main's first-parent chain,
//! newest first and capped: a merged side commit has no place there, its merge does. A
//! repository's imported head isn't anyone's landing, so it is left out while its log entry
//! is kept. A main that hasn't moved since 0039 has no chain, and lists nothing until it does.
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::Result;

const MAIN: &str = "refs/heads/main";
/// Chain entries read at most, so a long run of changes can't turn one list into a scan.
const SCAN: u64 = 1_000;

fn subject(message: &str) -> &str {
    let line = message.lines().next().unwrap_or_default();
    let mut end = line.len().min(super::changes::MAX_TITLE);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    &line[..end]
}

/// The newest `limit` landings on main that no change landed: each commit, its version and
/// time, its subject and its writer.
pub(super) fn recent<S: SqlStore>(db: &S, limit: u64) -> Result<Vec<Value>> {
    let found = db.query(
        "SELECT l.commit_id,l.version,l.landed_at,k.message,k.principal,\
         s.message AS shard_message,s.writer FROM \
         (SELECT commit_id FROM ref_chain WHERE ref=?1 ORDER BY depth DESC LIMIT ?2) r \
         JOIN landings l ON l.commit_id=r.commit_id AND l.refname=?1 \
         LEFT JOIN commits k ON k.id=l.commit_id \
         LEFT JOIN changesets s ON s.version=l.version AND s.commit_id=l.commit_id \
         LEFT JOIN txlog t ON t.version=l.version \
         WHERE NOT EXISTS (SELECT 1 FROM changes c WHERE c.landed_version=l.version) \
         AND COALESCE(json_extract(t.entry,'$.kind'),'')<>'import' \
         ORDER BY l.version DESC LIMIT ?3",
        &[json!(MAIN), json!(SCAN), json!(limit)],
    )?;
    Ok(found
        .into_iter()
        .map(|row| {
            let message = row["message"].as_str().or(row["shard_message"].as_str());
            let writer = &row[if row["principal"].is_null() {
                "writer"
            } else {
                "principal"
            }];
            json!({
                "commit": row["commit_id"],
                "version": row["version"],
                "landed_at": row["landed_at"],
                "title": subject(message.unwrap_or_default()),
                "author": writer,
            })
        })
        .collect())
}
