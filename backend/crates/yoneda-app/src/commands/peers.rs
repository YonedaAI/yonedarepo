//! Bounded awareness of assigned work, without exposing competing candidate source.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(super) fn read<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let job = active(db, c, now)?;
    if job["kind"] != "agent" {
        return Err(Error::new(
            "FORBIDDEN",
            "Only agent attempts can inspect peers",
        ));
    }
    let execution = &job["payload"]["execution"];
    let run_id = string(execution, "run_id")?;
    let peers=run_executions(db,&run_id)?.into_iter().map(|e| {
        let task=e["team_task"].as_str().and_then(|id| get(db,"team_tasks",id).ok());
        json!({"execution_id":e["id"],"self":e["id"]==execution["id"],"strategy":e["strategy"],"status":e["status"],"parent_execution":e["parent_execution"],"task":task.as_ref().map(|t|json!({"title":t["title"],"write_paths":t["write_paths"],"depends_on":t["depends_on"],"status":t["status"]}))})
    }).collect::<Vec<_>>();
    Ok(
        json!({"run_id":run_id,"peers":peers,"coverage":"same run; declared work and status only","observed_at":now}),
    )
}
