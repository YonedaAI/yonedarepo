//! Read-only supervisor grant for the interrupted attempt's staged workspace.
//!
//! The ledger recorded which earlier epoch of this same job holds the checkpoint
//! (`leases::resume`). Only the current, live epoch of that job can obtain this grant; it is
//! read-only, short-lived and bound to the old workspace's frozen binding, so the old
//! attempt can never be written through it and no other job can read it.
use super::*;

pub(super) fn grant<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let job = active(db, c, now)?;
    let resume = &job["resume"];
    if resume.is_null() {
        return Err(Error::new(
            "NOT_FOUND",
            "This attempt has no interrupted source checkpoint to resume",
        ));
    }
    let old: SourceBinding = decode(&resume["binding"])?;
    old.validate()?;
    if job["kind"] != "agent"
        || old.job_id != string(&job, "id")?
        || old.epoch >= number(&job, "epoch")?
        || json!(old.workspace_id) != resume["workspace_id"]
        || old.access != SourceAccess::ReadWrite
        || json!(old.execution_id) != job["payload"]["execution"]["id"]
    {
        return Err(Error::new(
            "FENCED",
            "Resume checkpoint does not belong to this job",
        ));
    }
    let expiry = number(&job, "lease_until")?
        .min(number(&job, "attempt_deadline")?)
        .min(now.saturating_add(120_000));
    let key = string(c, "_source_signing_key")?;
    let actor = source_workspace::sign_read_actor(&old, expiry, ActorPurpose::Supervisor, &key)?;
    Ok(
        json!({"version":1,"workspace_id":old.workspace_id,"epoch":old.epoch,
        "reason":resume["reason"],"binding":old,"actor_grant":actor}),
    )
}
