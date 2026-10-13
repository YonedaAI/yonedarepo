//! Trial locks and allowance configuration serialize in the same workspace transaction.
use super::*;

pub(super) fn require_legacy<S: SqlStore>(db: &S) -> Result<()> {
    if money(&state(db)?, "version")? >= 1 {
        return Err(Error::new(
            "WORKSPACE_LEGACY_INFERENCE_BLOCKED",
            "Use a new workspace-approved run after allowance transition",
        ));
    }
    Ok(())
}

pub(super) fn require_unlocked<S: SqlStore>(db: &S) -> Result<()> {
    let rows = db.query(
        "SELECT id,payload FROM workspace_records WHERE id='reviewer_policy' OR id LIKE 'campaign:%'",
        &[],
    )?;
    for row in rows {
        let id = string(&row, "id")?;
        let value: Value = serde_json::from_str(&string(&row, "payload")?)
            .map_err(|_| bad("Corrupt retained trial lock"))?;
        let primary = id == "reviewer_policy"
            || value["id"]
                .as_str()
                .is_some_and(|campaign| id == format!("campaign:{campaign}"));
        if primary && !value["active_trial"].is_null() {
            return Err(Error::new(
                "WORKSPACE_TRANSITION_BUSY",
                "A retained legacy trial reservation must finish before allowance transition",
            ));
        }
    }
    Ok(())
}
