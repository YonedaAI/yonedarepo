//! Operator-set account access: an account that once held a reviewer policy (the retired
//! judging trial) signs in only while that policy is unexpired and unrevoked. Nothing writes
//! a policy any more; existing ones keep their limits.
use super::*;

pub(super) fn valid<S: SqlStore>(db: &S, now: i64) -> Result<bool> {
    let rows = db.query(
        "SELECT payload FROM workspace_records WHERE id='reviewer_policy'",
        &[],
    )?;
    let Some(row) = rows.first() else {
        return Ok(true);
    };
    let policy: Value = serde_json::from_str(
        row["payload"]
            .as_str()
            .ok_or_else(|| bad("Corrupt reviewer policy"))?,
    )
    .map_err(|e| bad(&e.to_string()))?;
    Ok(policy["revoked"] != true && policy["expires"].as_i64().is_some_and(|e| e > now))
}
