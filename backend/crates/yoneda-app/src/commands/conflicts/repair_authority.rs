//! Conflict resolution is the repository owner's request, with the owner's brief.
use super::*;

pub(super) fn prepare<S: SqlStore>(
    db: &S,
    c: &Value,
    record: &Value,
) -> Result<(Value, Value, String)> {
    let run = get(db, "runs", &string(&record["candidate"], "run_id")?)?;
    if c.get("job_id").is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the repository owner starts a conflict resolution",
        ));
    }
    support::owner(c)?;
    let brief = string(c, "owner_brief")?;
    if brief.len() > 4096 {
        return Err(bad("Resolver brief exceeds 4096 bytes"));
    }
    Ok((run, json!({"approved_by":"repository_owner"}), brief))
}
