use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(super) fn record<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let job = active(db, &c, now)?;
    if job["kind"] != "agent" {
        return Err(Error::new(
            "FORBIDDEN",
            "Only agent harnesses record transcripts",
        ));
    }
    let digest = hash(&c, "digest", &[64])?;
    let id = string(&job["payload"]["execution"], "id")?;
    let mut execution = get(db, "executions", &id)?;
    if execution["transcript_epoch"] == job["epoch"] {
        if execution["transcript"] != digest {
            return Err(Error::new(
                "IMMUTABLE",
                "This attempt's transcript is already recorded",
            ));
        }
        return Ok(execution);
    }
    execution["transcript"] = json!(digest);
    execution["transcript_epoch"] = job["epoch"].clone();
    save_execution(db, &execution, now)?;
    event(
        db,
        "execution.transcript",
        now,
        json!({"id":id,"epoch":job["epoch"],"digest":digest}),
    )?;
    Ok(execution)
}
