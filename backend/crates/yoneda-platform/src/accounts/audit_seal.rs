//! Sealing an organization's audit log: its rows, in order and with their hashes, copied out
//! to immutable objects under `audit/v1/<org>/` (`platform-audit-seal.ts`), a prefix no purge
//! touches. The rows stay here: reads, verification and the cursors keep using them.
//!
//! `audit_seal_next` hands over the rows past the seal once a segment is full or its first
//! row is old, or at once with `all`. The adapter writes the object, then `audit_seal_done`
//! moves the seal, so a copy that dies is repeated, and nothing is ever marked sealed before
//! it is. Two running at once can leave segments that overlap: rows never change, so
//! that is harmless. The seal is a record, so this needs no migration.
use super::audit_log::{item, only_a_log, parsed};
use super::*;
use crate::storage::number;

const SEALED: &str = "audit_sealed";
/// Rows one object holds, and how many make a seal due.
const SEGMENT: i64 = 1000;
/// How long a row waits for its segment to fill: a day.
const OLD_MS: i64 = 24 * 60 * 60 * 1000;

fn sealed<S: SqlStore>(db: &S) -> Result<(i64, String)> {
    Ok(match get(db, SEALED) {
        Ok(seal) => (
            seal["seq"].as_i64().unwrap_or_default(),
            seal["hash"].as_str().unwrap_or_default().to_owned(),
        ),
        Err(_) => (0, String::new()),
    })
}

/// Whether the segment after `through` is due: asked for, full, or with an old first row. Reads
/// two rows, as this runs after every copy.
fn due<S: SqlStore>(db: &S, c: &Value, through: i64) -> Result<bool> {
    let first = db.query(
        "SELECT at FROM workspace_events WHERE seq=?",
        &[json!(through + 1)],
    )?;
    let Some(first) = first.first() else {
        return Ok(false);
    };
    let old = first["at"].as_i64().unwrap_or_default() + OLD_MS <= number(c, "now")?;
    if c["all"] == true || old {
        return Ok(true);
    }
    let last = db.query(
        "SELECT seq FROM workspace_events WHERE seq=?",
        &[json!(through + SEGMENT)],
    )?;
    Ok(!last.is_empty())
}

/// `audit_seal_next {all?}`: `due` with the next segment (`from`, `to`, the `hash` it ends on
/// and the `previous` it follows), or not `due`.
pub(super) fn next<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    only_a_log(db)?;
    let (through, previous) = sealed(db)?;
    if !due(db, c, through)? {
        return Ok(json!({ "due": false }));
    }
    let rows = db.query(
        "SELECT seq,kind,at,data FROM workspace_events WHERE seq>? ORDER BY seq LIMIT ?",
        &[json!(through), json!(SEGMENT)],
    )?;
    let items = rows.iter().map(item).collect::<Result<Vec<_>>>()?;
    let last = &items[items.len() - 1];
    Ok(json!({
        "due": true, "from": items[0]["seq"], "to": last["seq"], "hash": last["hash"],
        "previous": previous, "rows": items,
    }))
}

/// `audit_seal_done {to, hash}`: an object holds every row up to `to`, ending on `hash`, which
/// must be that row's. A repeat, or one behind the seal, changes nothing.
pub(super) fn done<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    only_a_log(db)?;
    let to = number(c, "to")?;
    let (through, _) = sealed(db)?;
    if to <= through {
        return Ok(json!({ "through": through }));
    }
    let hash = string(c, "hash")?;
    let row = db.query(
        "SELECT data FROM workspace_events WHERE seq=?",
        &[json!(to)],
    )?;
    if !row
        .first()
        .is_some_and(|row| parsed(row).is_ok_and(|data| data["hash"] == hash.as_str()))
    {
        return Err(bad("That is not the log's row"));
    }
    put(db, SEALED, &json!({ "seq": to, "hash": hash }))?;
    Ok(json!({ "through": to }))
}
