//! Deterministic exact source inputs; assertions alone never satisfy dependencies.
use super::*;
use std::collections::BTreeSet;

pub(super) fn inputs<S: SqlStore>(db: &S, run: &Value, task: &Value) -> Result<Value> {
    let plan = plan(run)?;
    let all = task["role"] == "integrator";
    let mut needed: BTreeSet<String> = task["depends_on"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    for _ in 0..plan.tasks.len() {
        let mut ancestors = Vec::new();
        for t in &plan.tasks {
            if all || needed.contains(&t.id) {
                ancestors.extend(t.depends_on.clone());
            }
        }
        needed.extend(ancestors);
    }
    let rid = string(run, "id")?;
    let mut outputs = Vec::new();
    for local in plan.order()? {
        if !all && !needed.contains(&local) {
            continue;
        }
        let source = get(db, "team_tasks", &task_id(&rid, &local))?;
        if source["status"] != "complete" || source["output"].is_null() {
            return Err(Error::new(
                "DEPENDENCY_BLOCKED",
                "Task source is not captured at an eligible version",
            ));
        }
        outputs.push(source["output"].clone());
    }
    Ok(json!(outputs))
}
pub(super) fn manifest<S: SqlStore>(db: &S, run: &Value) -> Result<Value> {
    let task = get(db, "team_tasks", &task_id(&string(run, "id")?, "integrate"))?;
    Ok(
        json!({"version":1,"plan_revision":run["team_plan_revision"],"base":run["base"],"inputs":inputs(db, run, &task)?}),
    )
}
pub(super) fn ready<S: SqlStore>(db: &S, run: &Value, task: &Value) -> Result<bool> {
    let rid = string(run, "id")?;
    for dependency in task["depends_on"].as_array().into_iter().flatten() {
        let d = get(
            db,
            "team_tasks",
            &task_id(
                &rid,
                dependency
                    .as_str()
                    .ok_or_else(|| bad("Invalid dependency"))?,
            ),
        )?;
        if d["status"] != "complete" {
            return Ok(false);
        }
    }
    Ok(true)
}
