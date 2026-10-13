use super::*;
pub(in crate::commands) fn budget_values<'a>(
    run: &'a Value,
    execution: Option<&Value>,
) -> Result<&'a Value> {
    let segment = run["comparison"]["approval"]["budget_scope"] == "comparison_approval";
    if segment && execution.is_none_or(|e| !e["comparison_approval_id"].is_null()) {
        validate(run)?;
        if let Some(e) = execution
            && e["comparison_approval_id"] != run["comparison"]["approval"]["id"]
        {
            return Err(Error::new(
                "FENCED",
                "Budget segment belongs to another approval",
            ));
        }
        return Ok(&run["comparison"]["model_budgets"]);
    }
    Ok(&run["model_budgets"])
}
pub(in crate::commands) fn put(
    run: &mut Value,
    execution: &Value,
    index: usize,
    budget: Value,
) -> Result<()> {
    budget_values(run, Some(execution))?;
    if run["comparison"]["approval"]["budget_scope"] == "comparison_approval"
        && !execution["comparison_approval_id"].is_null()
    {
        run["comparison"]["model_budgets"][index] = budget;
    } else {
        run["model_budgets"][index] = budget;
    }
    Ok(())
}
pub(in crate::commands) fn authorize_execution(run: &Value, job: &Value) -> Result<()> {
    let e = &job["payload"]["execution"];
    if e["comparison_approval_id"].is_null() {
        return Ok(());
    }
    validate(run)?;
    let a = &run["comparison"]["approval"];
    if e["comparison_approval_id"] != a["id"]
        || job["payload"]["run"]["comparison"]["approval"] != *a
        || ["cancelled", "accepted"]
            .iter()
            .any(|s| run["status"] == *s)
    {
        return Err(Error::new(
            "FENCED",
            "Comparison execution authority changed",
        ));
    }
    if e["comparison_role"] == "reviewer" {
        yoneda_core::comparison::validate_reviewer(run, e)?;
        if run["comparison"]["review_execution_id"] != e["id"]
            || e["comparison_round"] != run["comparison"]["round"]
        {
            return Err(Error::new("FENCED", "Reviewer superseded"));
        }
    } else if e["comparison_role"] == "repair" || e["comparison_role"] == "builder" {
        yoneda_core::adaptive_team::execution_effort(run, e)?;
    } else {
        return Err(Error::new("FENCED", "Unknown comparison execution role"));
    }
    Ok(())
}
pub(in crate::commands) fn record_request(run: &mut Value, e: &Value, total: i64) -> Result<()> {
    if run["comparison"]["approval"].is_null() || e["comparison_approval_id"].is_null() {
        return Ok(());
    }
    let round = e["comparison_round"]
        .as_u64()
        .and_then(|r| usize::try_from(r).ok())
        .filter(|r| *r <= 2)
        .ok_or_else(|| bad("Invalid comparison round"))?;
    let used = run["comparison"]["review_requests_by_round"][round]
        .as_i64()
        .unwrap_or(0);
    let sum = run["comparison"]["review_requests_by_round"]
        .as_array()
        .ok_or_else(|| bad("Missing round counters"))?
        .iter()
        .map(|v| v.as_i64().unwrap_or(0))
        .sum::<i64>();
    if total > 144 || e["comparison_role"] != "reviewer" && total > 144 - (36 - sum) {
        return Err(Error::new(
            "RESOURCE_LIMIT",
            "Comparison shared cap preserves the approved review slices",
        ));
    }
    if e["comparison_role"] == "reviewer" {
        if used >= 12 {
            return Err(Error::new(
                "MODEL_REQUEST_LIMIT",
                "This logical comparison review exhausted its 12-request slice",
            ));
        }
        run["comparison"]["review_requests_by_round"][round] = json!(used + 1);
    }
    Ok(())
}
