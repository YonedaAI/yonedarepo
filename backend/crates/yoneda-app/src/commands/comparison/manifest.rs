use super::*;
pub(in crate::commands) fn slot(run: &Value, e: &Value) -> Result<i64> {
    let count = run["agents"].as_array().map_or(0, Vec::len);
    let count = i64::try_from(count).map_err(|_| bad("Invalid original roster"))?;
    if let Some(i) = e["agent_index"].as_i64().filter(|i| (0..count).contains(i)) {
        return Ok(i);
    }
    let id = string(e, "id")?;
    for i in 0..count {
        if id == format!("{}:agent-{}", string(run, "id")?, i + 1) {
            return Ok(i);
        }
    }
    Err(Error::new(
        "FENCED",
        "Producer has no original comparison slot",
    ))
}
/// The original builder slot of a candidate's producer: no delegation, frozen model.
fn original_slot(run: &Value, execution: &Value) -> Result<i64> {
    if execution["run_id"] != run["id"]
        || execution["base"] != run["base"]
        || execution["role"] != "coding"
        || !execution["parent_execution"].is_null()
    {
        return Err(Error::new(
            "FENCED",
            "Original comparison source lineage changed",
        ));
    }
    let index = slot(run, execution)?;
    if execution["id"] != format!("{}:agent-{}", string(run, "id")?, index + 1) {
        return Err(Error::new("FENCED", "Original builder identity changed"));
    }
    let agent = &run["agents"][usize::try_from(index).map_err(|_| bad("Invalid original slot"))?];
    if execution["provider"] != agent["provider"]
        || execution["model"] != agent["model"]
        || execution["connection"]
            != *agent
                .get("connection")
                .filter(|v| !v.is_null())
                .unwrap_or(&agent["provider"])
    {
        return Err(Error::new(
            "FENCED",
            "Original builder model or connection changed",
        ));
    }
    Ok(index)
}
/// A candidate descends from an original builder on the run's base; a refresh moves only
/// its base, so lineage is its origin's.
pub(in crate::commands) fn ancestry<S: SqlStore>(db: &S, run: &Value, c: &Value) -> Result<()> {
    let candidate = super::refresh::origin(db, run, c)?;
    let e = get(db, "executions", &string(&candidate, "execution")?)?;
    original_slot(run, &e)?;
    if candidate["run_id"] != run["id"] || candidate["base"] != e["base"] {
        return Err(Error::new("FENCED", "Candidate ancestry changed"));
    }
    if candidate["base"] != run["base"] {
        return Err(Error::new("FENCED", "Original candidate base changed"));
    }
    Ok(())
}
pub(in crate::commands) fn checked<S: SqlStore>(db: &S, run: &Value, c: &Value) -> Result<()> {
    ancestry(db, run, c)?;
    if c["status"] != "eligible" {
        return Err(Error::new(
            "CHECKS_FAILED",
            "Selection requires an eligible captured candidate",
        ));
    }
    let evaluation: yoneda_agents_core::Evaluation =
        serde_json::from_value(get(db, "evaluations", &string(c, "evaluation")?)?)
            .map_err(|e| bad(&e.to_string()))?;
    let revision =
        serde_json::from_value(c["revision"].clone()).map_err(|e| bad(&e.to_string()))?;
    let policy =
        serde_json::from_value(repo(db)?["policy"].clone()).map_err(|e| bad(&e.to_string()))?;
    yoneda_agents_core::validate_evaluation(&evaluation, &string(c, "id")?, &revision, &policy)
}
