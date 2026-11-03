//! A bounded inbox needs a durable ordering floor, not an unbounded tombstone table.
//! Old replay can still send its pending mail; this floor changes inbox visibility only.
use super::*;
const FLOOR: &str = "notification_prune_floor";
pub(super) fn accepts<S: SqlStore>(db: &S, at: i64, id: &str) -> Result<bool> {
    let floor = match get(db, FLOOR) {
        Ok(value) => value,
        Err(e) if e.code == "NOT_FOUND" => return Ok(true),
        Err(e) => return Err(e),
    };
    let floor_at = crate::storage::number(&floor, "at")?;
    let floor_id = string(&floor, "id")?;
    Ok((at, id) > (floor_at, floor_id.as_str()))
}
pub(super) fn prune<S: SqlStore>(db: &S) -> Result<()> {
    let rows = db.query(
        "SELECT at,id FROM account_notifications ORDER BY at DESC,id DESC LIMIT 1 OFFSET 100",
        &[],
    )?;
    if let Some(boundary) = rows.first() {
        put(db, FLOOR, boundary)?;
        db.query(
            "DELETE FROM account_notifications WHERE at<? OR (at=? AND id<=?)",
            &[
                boundary["at"].clone(),
                boundary["at"].clone(),
                boundary["id"].clone(),
            ],
        )?;
    }
    Ok(())
}
