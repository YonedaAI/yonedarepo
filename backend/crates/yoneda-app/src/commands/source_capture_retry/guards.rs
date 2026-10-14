//! Immutable source, original builder and current head guards for owner recovery.
use super::*;
pub(super) fn validate_source(
    old: &Value,
    producer: &Value,
    registration: &Value,
    b: &SourceBinding,
    e: &Value,
    c: &Value,
) -> Result<()> {
    let pointer = &old["payload"]["source_registered"];
    if yoneda_core::fingerprint(&old["payload"]["policy"])? != b.policy_digest
        || producer["kind"] != "agent"
        || producer["status"] != "done"
        || producer["epoch"] != b.epoch
        || e["epoch"] != b.epoch
        || e["status"] != "failed"
        || e["run_id"] != b.run_id
        || producer["id"] != b.job_id
        || b.role != SourceRole::Builder
        || b.access != SourceAccess::ReadWrite
        || pointer["producer_epoch"] != b.epoch
        || pointer["registration_id"] != registration["registration_id"]
        || pointer["changeset_digest"] != registration["changeset_digest"]
        || c["expected_producer_epoch"] != b.epoch
        || c["expected_registration_id"] != registration["registration_id"]
        || old["payload"]["execution"]["id"] != b.execution_id
        || old["payload"]["execution"]["run_id"] != b.run_id
        || old["payload"]["sourceCaptureBase"] != json!(b.base)
        || producer["source_bindings"][&b.view_digest]["binding"] != json!(b)
        || old["payload"]["base"] != e["base"]
        || (!old["payload"]["execution"]["epoch"].is_null()
            && old["payload"]["execution"]["epoch"] != b.epoch)
    {
        return Err(Error::new(
            "SOURCE_CHANGED",
            "Capture recovery differs from the completed registered producer",
        ));
    }
    Ok(())
}
pub(super) fn validate_run<S: SqlStore>(
    db: &S,
    r: &Value,
    run: &Value,
    e: &Value,
    b: &SourceBinding,
    c: &Value,
) -> Result<()> {
    if b.repo_id != r["id"]
        || run["mode"] != "compare"
        || run["workspace_transport"] != "api-source-v1"
        || run["team_plan"].is_object()
        || run["adaptive_team"].is_object()
        || run["external"] == true
        || run["campaign"].is_object()
        || run["delegation"]["enabled"] == true
        || run["comparison"]["approval"]["budget_scope"] != "run"
        || !e["team_task"].is_null()
        || !e["parent_execution"].is_null()
        || e["depth"] != 0
        || e["role"] != "coding"
        || e["comparison_role"] != "builder"
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Recovery supports only original fixed comparison builders",
        ));
    }
    if ["cancelled", "accepted", "awaiting_intent"].contains(&run["status"].as_str().unwrap_or(""))
        || super::super::autonomy::intent_pending(run)
        || !run["comparison"]["selected_candidate_id"].is_null()
    {
        return Err(Error::new(
            "FENCED",
            "Run is paused, cancelled or already selected",
        ));
    }
    super::super::comparison::validate(run)?;
    let index = e["agent_index"]
        .as_u64()
        .filter(|i| *i < 2)
        .ok_or_else(|| bad("Original builder index missing"))?;
    let slot = usize::try_from(index).map_err(|_| bad("Invalid original builder slot"))?;
    let agent = &run["agents"][slot];
    if e["id"] != format!("{}:agent-{}", b.run_id, index + 1)
        || ["provider", "model", "connection", "reasoning_effort"]
            .iter()
            .any(|f| e[*f] != agent[*f])
        || e["comparison_approval_id"] != run["comparison"]["approval"]["id"]
        || e["base"] != run["base"]
    {
        return Err(Error::new("FENCED", "Original builder authority changed"));
    }
    super::super::branches::validate_run_head(db, run)?;
    let (commit, version) = if let Some(branch_id) = run["working_branch_id"].as_str() {
        let branch = get(db, "working_branches", branch_id)?;
        if branch["status"] != "active"
            || branch["working_revision"] != run["base"]
            || branch["canonical_base_commit"] != r["head_commit"]
            || branch["canonical_base_version"] != r["version"]
        {
            return Err(Error::new(
                "HEAD_MOVED",
                "Working branch or canonical root changed",
            ));
        }
        (branch["working_commit"].clone(), branch["version"].clone())
    } else {
        (r["head_commit"].clone(), r["version"].clone())
    };
    if commit != c["expected_commit"]
        || version != c["expected_version"]
        || b.base.commit != run["base"]["commit"]
        || b.base.repository != run["base"]["repository"]
        || json!(b.working_branch_id) != run["working_branch_id"]
        || json!(b.working_branch_version) != run["working_branch_version"]
    {
        return Err(Error::new(
            "HEAD_MOVED",
            "Approved source base or branch version changed",
        ));
    }
    if r["policy"] != run["policy"]
        || yoneda_core::fingerprint(&r["policy"])? != b.policy_digest
        || c["expected_policy_digest"] != b.policy_digest
        || b.intent_digest
            != yoneda_core::fingerprint(
                &json!({"intent":run["intent"],"clarifications":run["intent_clarifications"]}),
            )?
    {
        return Err(Error::new(
            "POLICY_CHANGED",
            "Source policy or intent changed",
        ));
    }
    if run_jobs(db, &b.run_id)?.iter().any(|j| {
        ["queued", "running", "awaiting_intent"].contains(&j["status"].as_str().unwrap_or(""))
    }) {
        return Err(Error::new(
            "AGENT_BUSY",
            "Finish current run work before retrying capture",
        ));
    }
    if run_executions(db,&b.run_id)?.iter().any(|child|child["parent_execution"]==e["id"]) || !db.query("SELECT id FROM candidates WHERE json_extract(payload,'$.execution')=? LIMIT 1",&[json!(b.execution_id)])?.is_empty() || !db.query("SELECT id FROM runs WHERE id<>? AND (json_extract(payload,'$.continuation_of')=? OR json_extract(payload,'$.restart_of')=?) LIMIT 1",&[json!(b.run_id),json!(b.run_id),json!(b.run_id)])?.is_empty(){return Err(Error::new("FENCED","Captured output or downstream work already exists"));}
    Ok(())
}
