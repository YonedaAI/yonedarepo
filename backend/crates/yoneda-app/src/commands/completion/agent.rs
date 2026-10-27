//! A contribution's completion queues the trusted platform capture of its submission.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
pub(super) fn complete<S: SqlStore>(db: &S, j: &Value, result: &Value, now: i64) -> Result<()> {
    let eid = string(&j["payload"]["execution"], "id")?;
    let mut e = get(db, "executions", &eid)?;
    let run_id = string(&e, "run_id")?;
    let run = get(db, "runs", &run_id)?;
    e["status"] = json!("completed");
    e["finished_at"] = json!(now);
    if result.get("transcript").is_some() {
        e["transcript"] = json!(hash(result, "transcript", &[64])?);
    }
    {
        let mut payload = json!({"execution":e,"run_id":run_id,"base":e["base"]});
        // Sandbox attempts finish through `sandbox_finish`; only a platform contribution
        // (an external agent's bound submission) completes here and is captured.
        if j["payload"]["workspace_transport"] != "platform-branch-v1" {
            return Err(Error::new(
                "INVALID_CAPTURE",
                "Attempts submit a platform contribution",
            ));
        }
        // The bound submission, never a commit named by the contributor's finish.
        payload["capture_subtype"] = json!("platform_commit");
        payload["contribution"] = j["submitted_revision"].clone();
        job(db, &format!("capture:{eid}"), "capture", now, payload)?;
        e["status"] = json!("capturing");
    }
    save(db, "runs", &run_id, &run)?;
    save_execution(db, &e, now)?;
    Ok(())
}
