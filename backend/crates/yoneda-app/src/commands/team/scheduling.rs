//! A dependency occupies no model container until trusted capture makes it ready.
use super::*;
use std::collections::BTreeSet;

pub(super) fn start<S: SqlStore>(db: &S, run: &Value, now: i64) -> Result<()> {
    let rid = string(run, "id")?;
    let plan = plan(run)?;
    for item in &plan.tasks {
        let id = task_id(&rid, &item.id);
        let task = json!({"id":id,"task_id":item.id,"run_id":rid,"agent":item.agent,"role":"worker","title":item.title,"instructions":item.instructions,"depends_on":item.depends_on,"write_paths":item.write_paths,"status":"blocked","epoch":0,"revision":1});
        create_task(db, &task, now)?;
    }
    let task = json!({"id":task_id(&rid,"integrate"),"task_id":"integrate","run_id":rid,"agent":plan.integrator_agent,"role":"integrator","title":"Integrate the team result","instructions":"Integrate every exact captured input and connect the shared contract into one complete implementation. Preserve all specialist outputs unless a scoped repair is required; describe repairs in the handoff.","depends_on":plan.order()?,"write_paths":plan.integration_paths,"status":"blocked","epoch":0,"revision":1});
    create_task(db, &task, now)?;
    for task in rows(db, "team_tasks", &rid)? {
        for dep in task["depends_on"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            edge(
                db,
                &format!("team-task:{}", string(&task, "id")?),
                &format!("team-task:{}", task_id(&rid, dep)),
                "depends_on",
                "frozen team DAG",
            )?;
        }
    }
    wake(db, run, now)
}
fn create_task<S: SqlStore>(db: &S, task: &Value, now: i64) -> Result<()> {
    let id = string(task, "id")?;
    create(db, "team_tasks", &id, task)?;
    node(
        db,
        &format!("team-task:{id}"),
        "team_task",
        &string(task, "title")?,
        "platform",
        now,
        task.clone(),
    )?;
    edge(
        db,
        &string(task, "run_id")?,
        &format!("team-task:{id}"),
        "assigns",
        "frozen team plan",
    )
}
pub(super) fn wake<S: SqlStore>(db: &S, run: &Value, now: i64) -> Result<()> {
    if run["status"] == "cancelled" || run["status"] == "accepted" {
        return Ok(());
    }
    let tasks = rows(db, "team_tasks", &string(run, "id")?)?;
    let mut reserved: BTreeSet<u64> = tasks
        .iter()
        .filter(|task| holds_slot(task))
        .map(|task| {
            task["agent"]
                .as_u64()
                .ok_or_else(|| bad("Invalid team agent slot"))
        })
        .collect::<Result<_>>()?;
    for task in tasks {
        let agent = task["agent"]
            .as_u64()
            .ok_or_else(|| bad("Invalid team agent slot"))?;
        if task["status"] == "blocked"
            && !reserved.contains(&agent)
            && inputs::ready(db, run, &task)?
        {
            schedule(db, run, task, now)?;
            reserved.insert(agent);
        }
    }
    Ok(())
}
fn schedule<S: SqlStore>(db: &S, run: &Value, mut task: Value, now: i64) -> Result<()> {
    let index = task["agent"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| bad("Invalid team agent"))?;
    let agent = run["agents"]
        .as_array()
        .and_then(|a| a.get(index))
        .ok_or_else(|| bad("Missing frozen team agent"))?;
    let id = string(&task, "id")?;
    let provider = string(agent, "provider")?;
    let harness = &yoneda_core::providers::provider(&provider)?.harness;
    let team_inputs = inputs::inputs(db, run, &task)?;
    let mut context: BTreeSet<String> = run["context"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    for input in team_inputs.as_array().into_iter().flatten() {
        if let Some(handoff) = input["handoff_id"].as_str() {
            context.insert(handoff.to_owned());
        }
    }
    let context: Vec<String> = context.into_iter().collect();
    let mut execution = json!({"id":id,"run_id":run["id"],"harness":harness,"provider":provider,"connection":agent.get("connection").cloned().unwrap_or_else(||json!(provider)),"model":agent["model"],"strategy":task["title"],"role":"coding","status":"queued","context":context,"base":run["base"],"depth":0,"team_task":id,"team_role":task["role"],"task":task["instructions"],"team_task_revision":task["revision"]});
    if let Some(routing) = agent.get("routing").filter(|v| !v.is_null()) {
        execution["routing"] = routing.clone();
    }
    if run.get("model_budgets").is_some() {
        execution["budget"] = json!({"provider":provider,"model":agent["model"]});
    }
    create(db, "executions", &id, &execution)?;
    node(
        db,
        &id,
        "execution",
        &string(&task, "title")?,
        "platform",
        now,
        execution.clone(),
    )?;
    let mut write: BTreeSet<String> = task["write_paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    for input in team_inputs.as_array().into_iter().flatten() {
        for path in input["paths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            write.insert(path.to_owned());
        }
        edge(
            db,
            &string(input, "handoff_id")?,
            &id,
            "provided_to",
            "exact captured dependency handoff",
        )?;
    }
    let mut payload = json!({"execution":execution,"run":run,"policy":run["policy"],"team_inputs":team_inputs,"team_owned_paths":task["write_paths"],"team_write_paths":write});
    if task["role"] == "integrator" {
        let manifest = inputs::manifest(db, run)?;
        let digest = yoneda_core::fingerprint(&manifest)?;
        let manifest_id = format!("integration:{}:1:{digest}", string(run, "id")?);
        node(
            db,
            &manifest_id,
            "integration_manifest",
            "Frozen team integration inputs",
            "platform",
            now,
            json!({"digest":digest,"manifest":manifest,"authority":"captured_inputs"}),
        )?;
        for input in payload["team_inputs"].as_array().into_iter().flatten() {
            edge(
                db,
                &string(input, "handoff_id")?,
                &manifest_id,
                "included_in",
                &digest,
            )?;
        }
        edge(db, &manifest_id, &id, "provided_to", &digest)?;
        payload["integration_digest"] = json!(digest);
        payload["manifest_record"] = get(db, "nodes", &manifest_id)?;
        payload["integration_manifest"] = manifest;
    }
    job(db, &format!("job:{id}"), "agent", now, payload.clone())?;
    task["status"] = json!("queued");
    task["execution_id"] = json!(id);
    task["inputs"] = payload["team_inputs"].clone();
    task["integration_digest"] = payload["integration_digest"].clone();
    save(db, "team_tasks", &id, &task)?;
    event(db, "team.task_scheduled", now, task)
}

/// Reservation begins at durable dispatch and survives harness finish until trusted capture.
pub(super) fn holds_slot(task: &Value) -> bool {
    matches!(
        task["status"].as_str(),
        Some("queued" | "running" | "capturing" | "evaluating")
    )
}
