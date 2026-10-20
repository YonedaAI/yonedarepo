use super::*;
pub(in crate::commands) fn launch<S: SqlStore>(
    db: &S,
    run: &mut Value,
    review: &Value,
    now: i64,
) -> Result<()> {
    validate(run)?;
    selection::validate_repair_head(db, run)?;
    if repo(db)?["policy"] != run["comparison"]["approval"]["policy"] {
        return Err(Error::new("POLICY_MOVED", "Repair policy changed"));
    }
    let round = number(&run["comparison"], "round")?
        .checked_add(1)
        .filter(|r| *r <= 2)
        .ok_or_else(|| Error::new("RESOURCE_LIMIT", "Comparison repair rounds exhausted"))?;
    let candidate = get(db, "candidates", &string(review, "candidate_id")?)?;
    manifest::ancestry(db, run, &candidate)?;
    let parent = get(db, "executions", &string(&candidate, "execution")?)?;
    let index = manifest::slot(run, &parent)?;
    let agent = &run["agents"][usize::try_from(index).map_err(|_| bad("Invalid builder slot"))?];
    let paths = crate::path_lists::load(db, &candidate, "paths")?;
    super::super::autonomy::validate_plan_scopes(&run["comparison"]["approval"]["policy"], &paths)?;
    let id = format!(
        "comparison-repair:{}:r{round}:{}",
        string(run, "id")?,
        string(&candidate, "id")?
    );
    let p = string(agent, "provider")?;
    let mut e = json!({"id":id,"run_id":run["id"],"provider":agent["provider"],"model":agent["model"],"connection":agent.get("connection").filter(|v|!v.is_null()).unwrap_or(&agent["provider"]),"harness":yoneda_agents_core::providers::provider(&p)?.harness,"role":"coding","strategy":agent["strategy"],"status":"queued","base":candidate["revision"],"context":run["context"],"depth":0,"agent_index":index,"comparison_role":"repair","comparison_round":round,"comparison_approval_id":run["comparison"]["approval"]["id"],"comparison_parent_candidate_id":candidate["id"],"budget":{"provider":agent["provider"],"model":agent["model"]}});
    for f in ["reasoning_effort", "routing", "version"] {
        if let Some(v) = agent.get(f) {
            e[f] = v.clone();
        }
    }
    run["execution_count"] = json!(
        number(run, "execution_count")?
            .checked_add(1)
            .filter(|n| *n <= 7)
            .ok_or_else(|| Error::new(
                "RESOURCE_LIMIT",
                "Comparison logical execution cap reached"
            ))?
    );
    run["comparison"]["round"] = json!(round);
    run["comparison"]["status"] = json!("repairing");
    run["status"] = json!("exploring");
    persist(db, run, now)?;
    create(db, "executions", &id, &e)?;
    save_execution(db, &e, now)?;
    node(
        db,
        &id,
        "execution",
        "Bounded comparison source repair",
        "platform",
        now,
        e.clone(),
    )?;
    let mut payload = json!({"execution":e,"run":run,"policy":run["comparison"]["approval"]["policy"],"comparison_repair":{"version":1,"approval_id":run["comparison"]["approval"]["id"],"round":round,"candidate_id":candidate["id"],"source_revision":candidate["revision"],"write_paths":paths,"instructions":review["repair_instructions"]}});
    if run["workspace_transport"] == "api-source-v1" {
        crate::path_lists::compact(db, &mut payload["comparison_repair"], "write_paths")?;
    }
    job(db, &format!("job:{id}"), "agent", now, payload)?;
    event(
        db,
        "comparison.repair_scheduled",
        now,
        json!({"run_id":run["id"],"execution_id":id,"round":round,"candidate_id":candidate["id"],"agent_index":index}),
    )?;
    Ok(())
}
pub(in crate::commands) fn validate_capture<S: SqlStore>(
    db: &S,
    j: &Value,
    result: &Value,
) -> Result<()> {
    if j["payload"]["execution"]["comparison_role"] != "repair" {
        return Ok(());
    }
    let run = get(db, "runs", &string(&j["payload"]["execution"], "run_id")?)?;
    validate(&run)?;
    let paths = result["paths"]
        .as_array()
        .ok_or_else(|| bad("Capture must enumerate repair paths"))?
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or_else(|| bad("Invalid capture path"))
        })
        .collect::<Result<Vec<_>>>()?;
    super::super::autonomy::validate_plan_scopes(&run["comparison"]["approval"]["policy"], &paths)
}
