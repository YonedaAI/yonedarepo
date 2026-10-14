//! Internal job construction keeps queue wait and approved execution time separate.
use super::{SqlStore, bad, create, get, outbox};
use serde_json::{Value, json};
use yoneda_core::Result;

/// Attribute lifecycle evidence using the saved job, independent of transport IDs.
pub(crate) fn job_event(job: &Value) -> Value {
    let payload = &job["payload"];
    json!({
        "id":job["id"], "kind":job["kind"], "epoch":job["epoch"],
        "run_id":payload["execution"]["run_id"].as_str()
            .or_else(|| payload["candidate"]["run_id"].as_str())
            .or_else(|| payload["run_id"].as_str()),
        "execution_id":payload["execution"]["id"].as_str()
            .or_else(|| payload["candidate"]["execution"].as_str())
    })
}

pub(crate) fn job<S: SqlStore>(
    db: &S,
    id: &str,
    kind: &str,
    now: i64,
    mut payload: Value,
) -> Result<()> {
    if ["agent", "capture", "evaluate"].contains(&kind) {
        // Guide check selection is derived from stored approval, never a job caller's payload.
        if let Some(object) = payload.as_object_mut() {
            object.remove("guided");
        }
        let run_id = payload["execution"]["run_id"]
            .as_str()
            .or_else(|| payload["run_id"].as_str())
            .or_else(|| payload["candidate"]["run_id"].as_str());
        let run = match run_id.map(|id| get(db, "runs", id)) {
            Some(Ok(run)) => Some(run),
            Some(Err(error)) if error.code == "NOT_FOUND" => None,
            Some(Err(error)) => return Err(error),
            None => None,
        };
        if let Some(run) = run.as_ref().filter(|run| run["guided"].is_object()) {
            let binding = if kind == "evaluate" {
                crate::commands::guided::evaluation_binding(db, &payload["candidate"])?
            } else {
                Some(run["guided"].clone())
            };
            if let Some(binding) = binding {
                payload["guided"] = binding;
            }
        }
        if (payload["comparison_review"] != true
            || run
                .as_ref()
                .is_some_and(|run| run["workspace_transport"] == "api-source-v1"))
            && let Some(transport) = run.as_ref().and_then(|r| r.get("workspace_transport"))
        {
            payload["workspace_transport"] = transport.clone();
        }
    }
    // The twenty-minute dispatch window must not truncate approved agent time.
    let execution_ms = if kind == "agent" {
        (if payload["run"]["comparison"]["approval"]["budget_scope"] == "comparison_approval"
            && !payload["execution"]["comparison_approval_id"].is_null()
        {
            &payload["run"]["comparison"]["model_budgets"]
        } else {
            &payload["run"]["model_budgets"]
        })
        .as_array()
        .and_then(|budgets| {
            budgets.iter().find(|budget| {
                budget["provider"] == payload["execution"]["provider"]
                    && budget["model"] == payload["execution"]["model"]
            })
        })
        .and_then(|budget| budget["max_execution_ms"].as_i64())
        .filter(|duration| {
            (60_000..=yoneda_core::model_budget::MAX_MODEL_EXECUTION_MS).contains(duration)
        })
        .unwrap_or(0)
    } else {
        0
    };
    let dispatch_deadline = now
        .checked_add(1_200_000)
        .ok_or_else(|| bad("Job dispatch deadline overflow"))?;
    let boot_ms = if execution_ms > 0 { 120_000 } else { 0 };
    let deadline = dispatch_deadline
        .checked_add(execution_ms)
        .and_then(|value| value.checked_add(boot_ms))
        .ok_or_else(|| bad("Job deadline overflow"))?;
    create(
        db,
        "jobs",
        id,
        &json!({"id":id,"kind":kind,"status":"queued","attempt":0,"epoch":0,"lease_until":0,"deadline":deadline,"dispatch_deadline":dispatch_deadline,"created_at":now,"payload":payload}),
    )?;
    outbox(db, &format!("dispatch:{id}:0"), kind, json!({"job_id":id}))
}
