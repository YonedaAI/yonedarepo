//! Refreshed comparison results: the ledger's clean merge of a candidate onto a newer target.
//!
//! A refresh keeps its parent's producer and lineage but moves the base to the refresh target,
//! so the original-base ancestry rule cannot apply to it. The link is trusted only when the
//! ledger-authored conflict record names exactly this parent, this result and this target.
use super::*;

/// Bound on refreshes of refreshes: canonical main can move more than once while a run waits.
const MAX_REFRESH_DEPTH: usize = 3;

/// The validated parent of a refreshed candidate, or `None` for a candidate that is no refresh.
pub(in crate::commands) fn parent<S: SqlStore>(
    db: &S,
    run: &Value,
    c: &Value,
) -> Result<Option<Value>> {
    let Some(parent_id) = c.get("refresh_of").and_then(Value::as_str) else {
        return Ok(None);
    };
    let fenced = || Error::new("FENCED", "Refreshed candidate lineage changed");
    let id = string(c, "conflict_id").map_err(|_| fenced())?;
    let record = get(db, "conflicts", &id).map_err(|_| fenced())?;
    let parent = get(db, "candidates", parent_id).map_err(|_| fenced())?;
    let head = &record["head_commit"];
    let target = record
        .get("target_revision")
        .filter(|v| !v.is_null())
        .unwrap_or(&c["base"]);
    if c["run_id"] != run["id"]
        || parent["run_id"] != run["id"]
        || record["candidate"]["run_id"] != run["id"]
        || record["status"] != "clean"
        || record["candidate_id"] != parent["id"]
        || record["refreshed_candidate_id"] != c["id"]
        || record["candidate_revision"] != parent["revision"]["commit"]
        || c["execution"] != parent["execution"]
        || c["base"] != *target
        || c["base"]["commit"] != *head
        || c["approved_parents"] != json!([head, parent["revision"]["commit"]])
        || c["refresh_expected_version"] != record["expected_version"]
    {
        return Err(fenced());
    }
    Ok(Some(parent))
}

/// Follows refresh links to the candidate that was actually produced and reviewed.
pub(in crate::commands) fn origin<S: SqlStore>(db: &S, run: &Value, c: &Value) -> Result<Value> {
    let mut current = c.clone();
    for _ in 0..=MAX_REFRESH_DEPTH {
        match parent(db, run, &current)? {
            Some(parent) => current = parent,
            None => return Ok(current),
        }
    }
    Err(Error::new("FENCED", "Refresh lineage exceeds its bound"))
}

/// Whether `c` is the selected candidate itself or a validated refresh of it.
pub(in crate::commands) fn is_selection<S: SqlStore>(
    db: &S,
    run: &Value,
    c: &Value,
) -> Result<bool> {
    let selected = &run["comparison"]["selected_candidate_id"];
    if selected.is_null() {
        return Ok(false);
    }
    let mut current = c.clone();
    for _ in 0..=MAX_REFRESH_DEPTH {
        if current["id"] == *selected {
            return Ok(true);
        }
        match parent(db, run, &current)? {
            Some(parent) => current = parent,
            None => return Ok(false),
        }
    }
    Ok(false)
}
