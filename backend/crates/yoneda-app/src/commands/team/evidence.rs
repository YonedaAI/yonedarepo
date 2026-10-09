//! Inclusion links establish exact source provenance, never assertion correctness.
use super::*;
pub(super) fn sources<S: SqlStore>(
    db: &S,
    execution: &str,
    epoch: &Value,
    checked: &[Value],
) -> Result<Vec<Value>> {
    let e = get(db, "executions", execution)?;
    if e["team_role"] != "worker" {
        return Ok(vec![]);
    }
    let rid = string(&e, "run_id")?;
    let mut result = Vec::new();
    for handoff in rows(db, "team_handoffs", &rid)?.into_iter().filter(|h| {
        h["execution_id"] == execution
            && h["epoch"] == *epoch
            && h["authority"] == "captured_revision"
    }) {
        let output = &handoff["output"];
        result.push(json!({"id":handoff["id"],"revision":output["revision"],"capture_job_id":output["capture_job"],"capture_kind":"task_contribution","evaluation":null}));
        for candidate in all(db, "candidates")?.into_iter().filter(|c| {
            c["run_id"] == rid
                && c["integration_manifest"]["inputs"]
                    .as_array()
                    .is_some_and(|inputs| {
                        inputs.iter().any(|i| {
                            i["handoff_id"] == handoff["id"] && i["revision"] == output["revision"]
                        })
                    })
        }) {
            let evaluation = checked.iter().find(|e| {
                e["candidate_id"] == candidate["id"]
                    && e["evaluation_id"] == candidate["evaluation"]
            });
            result.push(json!({"id":candidate["id"],"revision":candidate["revision"],"capture_job_id":candidate["capture_job"],"capture_kind":"integration","source_handoff":handoff["id"],"evaluation":evaluation}));
        }
    }
    Ok(result)
}
