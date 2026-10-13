//! Canonical human approval records immutable references, never adopts agent authorship.
use super::*;
pub(in crate::commands) fn decision<S: SqlStore>(db: &S, run: &Value, d: &mut Value) -> Result<()> {
    let comparison = &run["comparison"];
    if !comparison.is_object() {
        return Ok(());
    }
    if comparison["status"] != "selected" || comparison["selected_candidate_id"] != d["candidate"] {
        return Err(Error::new("FENCED", "Publication selection changed"));
    }
    let branch = match run["working_branch_id"].as_str() {
        Some(id) => get(db, "working_branches", id)?,
        None => Value::Null,
    };
    let mut snapshot = json!({"version":1,"selected_candidate_id":comparison["selected_candidate_id"],"selection_version":comparison["selection_version"],"selection_request_id":comparison["selection_request_id"],"selected_by":comparison["selected_by"],"selection_reason":comparison["selection_reason"],"working_branch_id":run["working_branch_id"],"working_branch_version":branch["version"],"working_revision":d["target"],"selection_policy_version":repo(db)?["policy"]["version"],"latest_review_id":comparison["latest_review_id"],"approval_id":comparison["approval"]["id"]});
    if let Some(id) = comparison["latest_review_id"].as_str() {
        let review = get(db, "nodes", id)?;
        if review["kind"] != "proposed_decision"
            || review["author"] != "agent_assertion"
            || review["data"] != comparison["latest_review"]
            || review["data"]["run_id"] != run["id"]
        {
            return Err(Error::new(
                "FENCED",
                "Recorded comparison assertion changed",
            ));
        }
        snapshot["review_authority"] = json!("agent_assertion");
        snapshot["manifest_digest"] = review["data"]["manifest_digest"].clone();
        snapshot["review_policy_version"] = review["data"]["manifest"]["policy"]["version"].clone();
        snapshot["review_selected_candidate_id"] = review["data"]["selected_candidate_id"].clone();
    }
    d["comparison"] = snapshot;
    Ok(())
}
pub(in crate::commands) fn link<S: SqlStore>(db: &S, d: &Value) -> Result<()> {
    if let Some(review) = d["comparison"]["latest_review_id"].as_str() {
        edge(
            db,
            &string(d, "id")?,
            review,
            "references_review",
            "recorded agent assertion; human publication rationale and approval remain separate",
        )?;
    }
    Ok(())
}
