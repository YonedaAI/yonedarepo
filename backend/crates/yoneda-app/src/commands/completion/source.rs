//! Coding can only hand off the current independently registered source seal.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    source_workspace::{SourceAccess, SourceBinding, SourceRole},
};
pub(super) fn payload<S: SqlStore>(db: &S, j: &Value, result: &Value, now: i64) -> Result<Value> {
    let r = &j["source_registered"]["registration"];
    let binding: SourceBinding = serde_json::from_value(r["binding"].clone()).map_err(|_| {
        Error::new(
            "INVALID_CAPTURE",
            "API source coding needs an independently registered seal",
        )
    })?;
    let expected = json!({"producer_job_id":j["id"],"producer_epoch":j["epoch"],"registration_id":r["registration_id"],"changeset_digest":r["changeset_digest"]});
    let e = &j["payload"]["execution"];
    if result["source_verified"] != true
        || result["source_registered"] != expected
        || binding.job_id != j["id"]
        || json!(binding.epoch) != j["epoch"]
        || binding.execution_id != e["id"]
        || binding.run_id != e["run_id"]
        || e["role"] != "coding"
        || binding.access != SourceAccess::ReadWrite
        || matches!(
            binding.role,
            SourceRole::Reviewer
                | SourceRole::Planner
                | SourceRole::Coordinator
                | SourceRole::Evaluator
        )
    {
        return Err(Error::new(
            "INVALID_CAPTURE",
            "Source completion differs from current approved producer seal",
        ));
    }
    // Refresh verifies current task, policy, input and lease guards without changing cached binding.
    crate::source_binding::handle(
        db,
        &json!({"op":"source_read_context","job_id":j["id"],"epoch":j["epoch"]}),
        now,
    )?;
    let policy = j["payload"]["policy"].clone();
    if policy != repo(db)?["policy"] || yoneda_core::fingerprint(&policy)? != binding.policy_digest
    {
        return Err(Error::new(
            "POLICY_CHANGED",
            "Source completion policy changed",
        ));
    }
    let mut execution = serde_json::Map::new();
    for key in [
        "id",
        "run_id",
        "role",
        "harness",
        "provider",
        "model",
        "connection",
        "agent_index",
        "comparison_role",
        "comparison_approval_id",
        "comparison_round",
        "comparison_parent_candidate_id",
        "team_role",
        "team_task",
        "team_task_revision",
        "source_execution",
        "base",
        "depth",
        "parent_execution",
        "parent_epoch",
        "conflict_id",
        "conflict_expected_version",
        "repair_round",
        "reasoning_effort",
    ] {
        if let Some(value) = e.get(key) {
            execution.insert(key.into(), value.clone());
        }
    }
    Ok(
        json!({"workspace_transport":"api-source-v1","capture_subtype":"source_changeset","execution":execution,"run_id":binding.run_id,"base":j["payload"]["execution"]["base"],"sourceCaptureBase":binding.base,"source_registered":expected,"policy":policy}),
    )
}
