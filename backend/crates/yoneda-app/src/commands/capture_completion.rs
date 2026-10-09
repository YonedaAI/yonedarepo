//! Trusted capture creates final candidates or intermediate team handoffs.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::Result;
pub(super) fn complete<S: SqlStore>(db: &S, j: &Value, result: &Value, now: i64) -> Result<()> {
    let cid = string(result, "id")?;
    let execution = &j["payload"]["execution"];
    let eid = string(execution, "id")?;
    let run_id = string(execution, "run_id")?;
    hash(&result["revision"], "commit", &[40, 64])?;
    string(&result["revision"], "repository")?;
    hash(result, "tree", &[40, 64])?;
    let paths = result["paths"]
        .as_array()
        .ok_or_else(|| bad("Capture must enumerate changed paths"))?;
    for path in paths {
        yoneda_core::validate_path(path.as_str().ok_or_else(|| bad("Invalid changed path"))?)?;
    }
    if super::team::captured(db, j, result, now)? {
        return Ok(());
    }
    let mut candidate = json!({"id":cid,"execution":eid,"run_id":run_id,"base":j["payload"]["base"],"revision":result["revision"],"tree":result["tree"],"paths":paths,"diff":result["diff"],"summary":result["summary"],"status":"evaluating","capture_job":j["id"]});
    if let Some(manifest) = j["payload"].get("integration_manifest") {
        candidate["integration_manifest"] = manifest.clone();
        candidate["integration_digest"] = j["payload"]["integration_digest"].clone();
    }
    create(db, "candidates", &cid, &candidate)?;
    node(
        db,
        &cid,
        "candidate",
        result["summary"].as_str().unwrap_or("Candidate"),
        "platform_capture",
        now,
        candidate.clone(),
    )?;
    edge(db, &eid, &cid, "produced_by", "independent source capture")?;
    let mut e = get(db, "executions", &eid)?;
    e["status"] = json!("evaluating");
    save_execution(db, &e, now)?;
    // Coding keeps its approved brief, while eligibility must use current
    // owner policy even if that policy changed before capture existed.
    let policy = repo(db)?["policy"].clone();
    job(
        db,
        &format!("evaluate:{cid}"),
        "evaluate",
        now,
        json!({"candidate":candidate,"run_id":run_id,"policy":policy}),
    )?;
    Ok(())
}
