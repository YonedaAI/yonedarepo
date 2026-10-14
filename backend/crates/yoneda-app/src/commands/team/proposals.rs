//! Immutable attempt-scoped drafts with an optimistic pointer; only planning completion freezes one.
use super::*;

#[cfg(test)]
#[path = "tests/adaptive_team.rs"]
mod adaptive_tests;
#[cfg(test)]
#[path = "tests/adaptive_specialists.rs"]
mod specialist_tests;

pub(super) const MAX_DRAFTS: i64 = 8;

fn id(job: &Value, fingerprint: &str) -> Result<String> {
    Ok(format!(
        "team-plan-proposal:{}:{}:{fingerprint}",
        string(job, "id")?,
        number(job, "epoch")?
    ))
}

fn identity(proposal: &Value, job: &Value, run: &Value) -> Result<()> {
    let execution = &job["payload"]["execution"];
    if proposal["data"]["execution_id"] != execution["id"]
        || proposal["data"]["job_id"] != job["id"]
        || proposal["data"]["run_id"] != run["id"]
        || proposal["author"] != execution["id"]
        || proposal["kind"] != "team_plan_proposal"
        || proposal["data"]["authority"] != "assertion"
        || run["adaptive_team"].is_object()
            && job["payload"]["run"]["autonomy_approval"] != run["autonomy_approval"]
    {
        return Err(Error::new("FENCED", "Team plan proposal identity changed"));
    }
    Ok(())
}

pub(super) fn validated(proposal: &Value, job: &Value, run: &Value) -> Result<TeamPlan> {
    identity(proposal, job, run)?;
    if run["adaptive_team"].is_object() {
        super::super::adaptive_team::validate_approval(run)?;
    }
    if proposal["data"]["epoch"] != job["epoch"] {
        return Err(Error::new("FENCED", "Team plan proposal attempt changed"));
    }
    let plan: TeamPlan = serde_json::from_value(proposal["data"]["plan"].clone())
        .map_err(|e| bad(&e.to_string()))?;
    let agents = roster(proposal, run)?;
    plan.validate(
        agents
            .as_ref()
            .unwrap_or(&run["agents"])
            .as_array()
            .map_or(0, Vec::len),
    )?;
    let fingerprint = plan_digest(&plan, agents.as_ref())?;
    if proposal["data"]["fingerprint"] != fingerprint || proposal["id"] != id(job, &fingerprint)? {
        return Err(Error::new("FENCED", "Team plan proposal digest changed"));
    }
    Ok(plan)
}

pub(super) fn roster(proposal: &Value, run: &Value) -> Result<Option<Value>> {
    if run["adaptive_team"].is_null() {
        if proposal["data"].get("agents").is_some() {
            return Err(Error::new(
                "FENCED",
                "Legacy proposal added an unapproved roster",
            ));
        }
        return Ok(None);
    }
    let agents = &proposal["data"]["agents"];
    super::super::adaptive_team::validate_roster(run, agents)?;
    if proposal["data"]["roster_digest"] != yoneda_core::fingerprint(agents)? {
        return Err(Error::new(
            "FENCED",
            "Proposed adaptive roster digest changed",
        ));
    }
    Ok(Some(agents.clone()))
}

fn plan_digest(plan: &TeamPlan, agents: Option<&Value>) -> Result<String> {
    yoneda_core::fingerprint(&agents.map_or_else(
        || json!(plan),
        |agents| json!({"plan":plan,"agents":agents}),
    ))
}

pub(super) fn current<S: SqlStore>(db: &S, job: &Value, run: &Value) -> Result<Option<Value>> {
    let Some(id) = run.get("team_plan_proposal").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let proposal = get(
        db,
        "nodes",
        id.as_str()
            .ok_or_else(|| bad("Invalid team plan draft pointer"))?,
    )?;
    identity(&proposal, job, run)?;
    // A retry starts its own draft sequence. The prior attempt's assertion remains in the graph.
    if number(&proposal["data"], "epoch")? < number(job, "epoch")? {
        return Ok(None);
    }
    validated(&proposal, job, run)?;
    Ok(Some(proposal))
}

pub(super) fn count<S: SqlStore>(db: &S, job: &Value) -> Result<i64> {
    let rows = db.query(
        "SELECT COUNT(*) AS total FROM nodes WHERE json_extract(payload,'$.kind')='team_plan_proposal' AND json_extract(payload,'$.data.job_id')=? AND json_extract(payload,'$.data.epoch')=?",
        &[job["id"].clone(), job["epoch"].clone()],
    )?;
    rows.first()
        .and_then(|r| r["total"].as_i64())
        .ok_or_else(|| Error::new("DATABASE", "Team plan draft count missing"))
}

pub(super) fn propose<S: SqlStore>(
    db: &S,
    c: &Value,
    job: &Value,
    run: &Value,
    now: i64,
) -> Result<Value> {
    let mut plan: TeamPlan =
        serde_json::from_value(c["plan"].clone()).map_err(|e| bad(&e.to_string()))?;
    let agents = super::super::adaptive_team::select(run, c.get("agents"), &mut plan)?;
    plan.validate(
        agents
            .as_ref()
            .unwrap_or(&run["agents"])
            .as_array()
            .map_or(0, Vec::len),
    )?;
    let fingerprint = plan_digest(&plan, agents.as_ref())?;
    let execution = &job["payload"]["execution"];
    let id = id(job, &fingerprint)?;
    match get(db, "nodes", &id) {
        Ok(existing) => {
            validated(&existing, job, run)?;
            // Returning an older immutable record must never select it again as the active draft.
            return Ok(existing);
        }
        Err(error) if error.code == "NOT_FOUND" => {}
        Err(error) => return Err(error),
    }
    let previous = current(db, job, run)?;
    let expected = c.get("expected_proposal").filter(|v| !v.is_null());
    if let Some(previous) = &previous {
        let expected = expected.ok_or_else(|| {
            Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Changing this attempt's draft requires its current expected_proposal ID from team_context",
            )
        })?;
        if !expected.is_string() {
            return Err(bad("expected_proposal must be a draft record ID"));
        }
        if expected != &previous["id"] {
            return Err(Error::new(
                "STALE_PROPOSAL",
                "The active team plan draft changed",
            ));
        }
    } else if expected.is_some() {
        return Err(Error::new(
            "STALE_PROPOSAL",
            "This attempt has no active team plan draft",
        ));
    }
    let revision = count(db, job)? + 1;
    if revision > MAX_DRAFTS {
        return Err(Error::new(
            "TEAM_PLAN_DRAFT_LIMIT",
            "This planner attempt reached its eight unique draft versions",
        ));
    }
    let previous_id = previous.as_ref().map(|p| p["id"].clone());
    let mut data = json!({"plan":plan,"fingerprint":fingerprint,"run_id":run["id"],"execution_id":execution["id"],"job_id":job["id"],"epoch":job["epoch"],"authority":"assertion","draft_revision":revision,"supersedes":previous_id});
    if let Some(agents) = agents {
        data["roster_digest"] = json!(yoneda_core::fingerprint(&agents)?);
        data["agents"] = agents;
    }
    node(
        db,
        &id,
        "team_plan_proposal",
        "Proposed team implementation plan",
        &string(execution, "id")?,
        now,
        data,
    )?;
    edge(
        db,
        &string(execution, "id")?,
        &id,
        "proposes",
        "agent draft assertion; tasks await successful planner completion",
    )?;
    if let Some(previous) = previous {
        edge(
            db,
            &string(&previous, "id")?,
            &id,
            "superseded_by",
            "optimistic draft revision before any task dispatch",
        )?;
    }
    event(
        db,
        "team.plan_proposed",
        now,
        json!({"id":id,"run_id":run["id"],"execution_id":execution["id"],"epoch":job["epoch"],"draft_revision":revision}),
    )?;
    let mut saved_run = run.clone();
    saved_run["team_plan_proposal"] = json!(id);
    save(db, "runs", &string(&saved_run, "id")?, &saved_run)?;
    get(db, "nodes", &id)
}
