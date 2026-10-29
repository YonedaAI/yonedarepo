//! Purging quarantined content. A claim leases records (`epoch` is bumped, `lease_until`
//! set); the adapter deletes their bytes outside any transaction, then reports the claims
//! it finished. A report at an older epoch (its lease ran out and another run claimed the
//! record) changes nothing; a record stays withheld whatever happens to a purge, so a lost
//! report only means the next run deletes again (deleting is idempotent).
use super::{COLUMNS, Target, record, record_id, shaped};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// How long a claim holds its records; the adapter deletes only with a margin of it left.
pub const LEASE_MS: i64 = 5 * 60 * 1000;
/// Records one claim hands out.
const MAX_CLAIM: i64 = 100;

pub(super) fn busy(id: i64) -> Error {
    Error::new(
        "CONFLICT",
        format!("Record {id} is being purged; retry in a few minutes"),
    )
}

/// A leased record as a claim answers it; a session's names its stored transcript
/// (`transcript_sha256`), whose document the adapter deletes.
fn claimed<S: SqlStore>(db: &S, row: &Value) -> Result<Value> {
    let mut claim = shaped(row);
    claim["epoch"] = row["epoch"].clone();
    if row["target_kind"] == Target::Session.as_str() {
        let id = row["target_id"].as_str().unwrap_or_default();
        claim["transcript_sha256"] = super::sessions::transcript_sha256(db, id)?;
    }
    Ok(claim)
}

/// `repo_quarantine_purge {id, confirm}`: the owner's purge now. `confirm` must repeat the
/// target's id; the answer leases the record to the caller (`claims`, until `lease_until`).
pub(super) fn now<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let now = number(c, "now")?;
    let id = record_id(c)?;
    let current = record(db, id)?;
    if c["confirm"].as_str() != current["target"]["id"].as_str() {
        return Err(bad(
            "confirm must repeat the quarantined target's id: purging cannot be undone",
        ));
    }
    if current["state"] != "quarantined" {
        return Err(Error::new(
            "CONFLICT",
            format!("Record {id} is {}, not quarantined", current["state"]),
        ));
    }
    let lease_until = now + LEASE_MS;
    let rows = db.query(
        &format!(
            "UPDATE quarantine SET epoch=epoch+1,lease_until=? WHERE id=? AND state='quarantined' \
             AND (lease_until IS NULL OR lease_until<=?) RETURNING {COLUMNS},epoch"
        ),
        &[json!(lease_until), json!(id), json!(now)],
    )?;
    let row = rows.first().ok_or_else(|| busy(id))?;
    let claim = claimed(db, row)?;
    Ok(json!({ "claims": [claim], "lease_until": lease_until }))
}

/// `repo_quarantine_claim {limit}`: leases up to `limit` records whose retention has passed.
/// `next_at` is when the job is due again (null: nothing waits).
pub(super) fn claim<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let now = number(c, "now")?;
    let limit = number(c, "limit")?;
    if !(1..=MAX_CLAIM).contains(&limit) {
        return Err(bad(&format!("limit must be 1 to {MAX_CLAIM}")));
    }
    let lease_until = now + LEASE_MS;
    let rows = db.query(
        &format!(
            "UPDATE quarantine SET epoch=epoch+1,lease_until=? WHERE id IN \
             (SELECT id FROM quarantine WHERE state='quarantined' AND purge_after<=? \
              AND (lease_until IS NULL OR lease_until<=?) ORDER BY purge_after LIMIT ?) \
             RETURNING {COLUMNS},epoch"
        ),
        &[json!(lease_until), json!(now), json!(now), json!(limit)],
    )?;
    // Due again when a record's retention ends, or (for a leased one, whose finisher may
    // die) when its lease does.
    let next = db.query(
        "SELECT MIN(CASE WHEN lease_until>?1 THEN MAX(purge_after,lease_until) ELSE purge_after END) \
         AS at FROM quarantine WHERE state='quarantined'",
        &[json!(now)],
    )?;
    let next_at = next.first().map_or(Value::Null, |r| r["at"].clone());
    Ok(json!({
        "claims": rows.iter().map(|r| claimed(db, r)).collect::<Result<Vec<_>>>()?,
        "lease_until": lease_until, "next_at": next_at,
    }))
}

/// `repo_quarantine_purged {claims: [{id, epoch}]}`: the claimed content is deleted. Each
/// record still at its claim's epoch becomes purged (a session record's text, and its
/// session's memories' text, are cleared here, in the same transaction); `purged` counts
/// them.
pub(super) fn done<S: SqlStore>(db: &S, c: &Value, actor: &super::Actor) -> Result<Value> {
    let now = number(c, "now")?;
    let claims = c["claims"]
        .as_array()
        .filter(|list| list.len() <= MAX_CLAIM as usize)
        .ok_or_else(|| bad(&format!("claims must be a list of at most {MAX_CLAIM}")))?;
    let mut purged = 0;
    for claim in claims {
        let (Some(id), Some(epoch)) = (claim["id"].as_i64(), claim["epoch"].as_i64()) else {
            return Err(bad("each claim needs its id and epoch"));
        };
        let rows = db.query(
            "UPDATE quarantine SET state='purged',purged_at=?,purged_by=?,lease_until=NULL \
             WHERE id=? AND epoch=? AND state='quarantined' RETURNING target_kind,target_id",
            &[json!(now), json!(actor.principal), json!(id), json!(epoch)],
        )?;
        let Some(row) = rows.first() else { continue };
        purged += 1;
        if Target::parse(row["target_kind"].as_str().unwrap_or_default())? == Target::Session {
            let id = row["target_id"].as_str().unwrap_or_default();
            super::sessions::clear(db, id)?;
            super::memories::clear(db, id)?;
        }
    }
    Ok(json!({ "purged": purged }))
}
