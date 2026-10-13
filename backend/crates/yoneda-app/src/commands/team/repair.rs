//! Bounded owner or coordinator repair reopens an affected DAG suffix.
use super::*;
use std::collections::BTreeSet;
#[path = "amendments.rs"]
mod amendments;
#[path = "repair_fences.rs"]
mod fences;

pub(super) fn repair<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if c.get("_grant").is_some() || c.get("_reviewer").is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the repository owner can repair a team run",
        ));
    }
    let rid = string(c, "run_id")?;
    let mut run = get(db, "runs", &rid)?;
    let request_id = string(c, "request_id")?;
    let agent = c.get("job_id").is_some();
    let caller = if agent {
        Some(active(db, c, now)?)
    } else {
        None
    };
    let fingerprint = yoneda_core::fingerprint(
        &json!({"run_id":c["run_id"],"expected_commit":c["expected_commit"],"expected_version":c["expected_version"],"expected_plan_revision":c["expected_plan_revision"],"task_ids":c["task_ids"],"expected_task_revisions":c["expected_task_revisions"],"owner_brief":c["owner_brief"],"task_definitions":c["task_definitions"]}),
    )?;
    if let Some(receipts) = run["team_repair_receipts"].as_array()
        && let Some(previous) = receipts.iter().find(|v| v["request_id"] == request_id)
    {
        if previous["fingerprint"] != fingerprint {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Repair request ID was reused with different input",
            ));
        }
        if agent
            && previous["execution_id"]
                != caller
                    .as_ref()
                    .map(|j| &j["payload"]["execution"]["id"])
                    .unwrap_or(&Value::Null)
                    .clone()
        {
            return Err(Error::new(
                "FORBIDDEN",
                "Repair receipt belongs to a different authority",
            ));
        }
        return Ok(previous["receipt"].clone());
    }
    let authorization = if agent {
        super::super::autonomy::authorize_repair(db, c, &run, now)?
    } else {
        json!({"approved_by":"repository_owner"})
    };
    super::super::branches::validate_run_head(db, &run)?;
    if run["base"]["commit"] != c["expected_commit"]
        || run
            .get("working_branch_version")
            .unwrap_or(&run["base_version"])
            != &c["expected_version"]
    {
        return Err(Error::new(
            "HEAD_MOVED",
            "Repair requires the exact reserved working head and version",
        ));
    }
    if run["mode"] != "collaborate"
        || ["cancelled", "accepted"].contains(&run["status"].as_str().unwrap_or_default())
    {
        return Err(Error::new(
            "INVALID_STATE",
            "This team run cannot be repaired",
        ));
    }
    if run["team_plan_revision"] != c["expected_plan_revision"] {
        return Err(Error::new("PLAN_MOVED", "Team plan revision changed"));
    }
    let brief = if agent {
        format!(
            "Repair the approved goal: {}. Acceptance criteria: {}. Frozen context: {}",
            run["intent"], run["criteria"], run["context"]
        )
    } else {
        string(c, "owner_brief")?
    };
    if !agent && brief.len() > 4096 {
        return Err(bad("Owner repair brief exceeds 4096 bytes"));
    }
    let selected: BTreeSet<String> = c["task_ids"]
        .as_array()
        .ok_or_else(|| bad("task_ids must be an array"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| bad("Invalid task ID"))
        })
        .collect::<Result<_>>()?;
    if selected.is_empty() || selected.len() > yoneda_core::team::MAX_TEAM_TASKS {
        return Err(bad("Select 1–16 tasks to repair"));
    }
    let rounds = run["team_repair_rounds"].as_u64().unwrap_or_default();
    if rounds >= 2 {
        return Err(Error::new(
            "REPAIR_BUDGET_EXHAUSTED",
            "The two-round team repair budget is exhausted",
        ));
    }
    let tasks = rows(db, "team_tasks", &rid)?;
    let (next_definition, additions) = amendments::apply(db, c, &run, &selected, agent)?;
    let mut affected = selected.clone();
    for _ in 0..tasks.len() {
        for task in &tasks {
            let local = string(task, "task_id")?;
            if task["depends_on"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|d| d.as_str().is_some_and(|d| affected.contains(d)))
            {
                affected.insert(local);
            }
        }
    }
    for _ in 0..next_definition.tasks.len() {
        for task in &next_definition.tasks {
            if task.depends_on.iter().any(|d| affected.contains(d)) {
                affected.insert(task.id.clone());
            }
        }
    }
    affected.insert("integrate".into());
    super::super::budget_availability::require_assignment(&run, next_definition.integrator_agent)?;
    for task in next_definition
        .tasks
        .iter()
        .filter(|t| affected.contains(&t.id))
    {
        super::super::budget_availability::require_assignment(&run, task.agent)?;
    }
    for local in if agent { &affected } else { &selected } {
        if additions.contains(local) {
            continue;
        }
        let task = tasks
            .iter()
            .find(|t| t["task_id"] == *local)
            .ok_or_else(|| Error::new("NOT_FOUND", "Unknown team task"))?;
        if task["revision"] != c["expected_task_revisions"][local] {
            return Err(Error::new(
                "TASK_MOVED",
                "An affected task revision changed",
            ));
        }
    }
    let next_plan = run["team_plan_revision"]
        .as_i64()
        .unwrap_or_default()
        .checked_add(1)
        .ok_or_else(|| bad("Plan revision overflow"))?;
    let next_round = rounds + 1;
    let task_revisions: Value = selected
        .iter()
        .filter_map(|task_id| {
            tasks
                .iter()
                .find(|task| task["task_id"] == *task_id)
                .map(|task| (task_id.clone(), task["revision"].clone()))
        })
        .collect();
    let mut amendments = run["team_plan_amendments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    amendments.push(json!({"plan_revision":next_plan,"supersedes_revision":run["team_plan_revision"],"repair_round":next_round,"selected_tasks":selected,"expected_task_revisions":task_revisions,"owner_brief":brief,"approved_by":authorization["approved_by"],"execution_id":authorization["execution_id"],"policy_digest":authorization["policy_digest"],"task_definitions":c["task_definitions"],"created_at":now}));
    run["team_plan"] = json!(next_definition);
    run["team_plan_revision"] = json!(next_plan);
    run["execution_count"] = json!(
        run["execution_count"]
            .as_u64()
            .unwrap_or_default()
            .checked_add(
                u64::try_from(additions.len()).map_err(|_| bad("Execution count overflow"))?
            )
            .ok_or_else(|| bad("Execution count overflow"))?
    );
    run["team_repair_rounds"] = json!(next_round);
    run["team_repair_brief"] = json!(brief);
    run["team_plan_amendments"] = json!(amendments);
    run["status"] = json!("exploring");
    let receipt = json!({"run_id":rid,"plan_revision":next_plan,"repair_round":next_round,"affected_tasks":affected,"status":"repairing","integrator_agent":next_definition.integrator_agent});
    let mut receipts = run["team_repair_receipts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    receipts.push(json!({"request_id":request_id,"fingerprint":fingerprint,"execution_id":authorization["execution_id"],"receipt":receipt}));
    run["team_repair_receipts"] = json!(receipts);
    save(db, "runs", &rid, &run)?;
    let mut tasks = tasks;
    for definition in next_definition
        .tasks
        .iter()
        .filter(|t| additions.contains(&t.id))
    {
        let task = json!({"id":task_id(&rid,&definition.id),"task_id":definition.id,"run_id":rid,"agent":definition.agent,"role":"worker","title":definition.title,"instructions":definition.instructions,"depends_on":definition.depends_on,"write_paths":definition.write_paths,"status":"blocked","epoch":0,"revision":0});
        scheduling::create_task(db, &task, now)?;
        tasks.push(task);
    }
    for mut task in tasks
        .into_iter()
        .filter(|t| affected.contains(t["task_id"].as_str().unwrap_or_default()))
    {
        fences::supersede_task_attempts(db, &rid, &task, now)?;
        if let Some(definition) = next_definition
            .tasks
            .iter()
            .find(|t| task["task_id"] == t.id)
        {
            let definition = json!(definition);
            for key in [
                "agent",
                "title",
                "instructions",
                "depends_on",
                "write_paths",
            ] {
                task[key] = definition[key].clone();
            }
        } else if task["role"] == "integrator" {
            task["depends_on"] = json!(next_definition.order()?);
            task["agent"] = json!(next_definition.integrator_agent);
        }
        let revision = number(&task, "revision")?
            .checked_add(1)
            .ok_or_else(|| bad("Task revision overflow"))?;
        task["revision"] = json!(revision);
        task["status"] = json!("blocked");
        task["output"] = Value::Null;
        task["candidate_id"] = Value::Null;
        task["error"] = Value::Null;
        task["repair_round"] = json!(next_round);
        if selected.contains(task["task_id"].as_str().unwrap_or_default()) {
            if !agent {
                task["owner_brief"] = json!(brief);
            }
            let original = task["instructions"].as_str().unwrap_or_default();
            task["instructions"] =
                json!(format!("{original}\n\nApproved repair guidance: {brief}"));
        }
        save(db, "team_tasks", &string(&task, "id")?, &task)?;
    }
    event(
        db,
        "team.repair_approved",
        now,
        json!({"run_id":rid,"plan_revision":next_plan,"round":next_round,"tasks":affected,"repair_guidance":brief,"approved_by":authorization["approved_by"],"integrator_agent":next_definition.integrator_agent}),
    )?;
    scheduling::wake(db, &run, now)?;
    Ok(receipt)
}

#[cfg(test)]
#[path = "repair_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "tests/autonomous_repair.rs"]
mod autonomous_tests;

#[cfg(test)]
#[path = "tests/recovery_lifecycle.rs"]
mod lifecycle_tests;

#[cfg(test)]
#[path = "tests/escalation.rs"]
mod escalation_tests;

#[cfg(test)]
#[path = "tests/intent_evaluation.rs"]
mod intent_evaluation_tests;

#[cfg(test)]
#[path = "tests/plan_scopes.rs"]
mod plan_scope_tests;

#[cfg(test)]
#[path = "tests/budget_availability.rs"]
mod budget_tests;
