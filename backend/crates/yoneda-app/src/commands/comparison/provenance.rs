//! A publication decision records the owner's exact comparison selection.
use super::*;
pub(in crate::commands) fn decision<S: SqlStore>(db: &S, run: &Value, d: &mut Value) -> Result<()> {
    let comparison = &run["comparison"];
    if !comparison.is_object() {
        return Ok(());
    }
    let candidate = get(db, "candidates", &string(d, "candidate")?)?;
    if comparison["status"] != "selected" || !super::refresh::is_selection(db, run, &candidate)? {
        return Err(Error::new("FENCED", "Publication selection changed"));
    }
    let branch = match run["working_branch_id"].as_str() {
        Some(id) => get(db, "working_branches", id)?,
        None => Value::Null,
    };
    let mut snapshot = json!({"version":1,"selected_candidate_id":comparison["selected_candidate_id"],"selection_version":comparison["selection_version"],"selection_request_id":comparison["selection_request_id"],"selected_by":comparison["selected_by"],"selection_reason":comparison["selection_reason"],"working_branch_id":run["working_branch_id"],"working_branch_version":branch["version"],"working_revision":d["target"],"selection_policy_version":repo(db)?["policy"]["version"]});
    if comparison["selected_candidate_id"] != d["candidate"] {
        snapshot["refreshed_candidate_id"] = d["candidate"].clone();
    }
    d["comparison"] = snapshot;
    Ok(())
}
