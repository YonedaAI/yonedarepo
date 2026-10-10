//! Owner-approved bounded repair reopens an affected DAG suffix and fences its old attempts.
use super::*;
use std::collections::BTreeSet;

pub(super) fn repair<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if c.get("job_id").is_some() || c.get("_grant").is_some() || c.get("_reviewer").is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the repository owner can repair a team run",
        ));
    }
    let rid = string(c, "run_id")?;
    let mut run = get(db, "runs", &rid)?;
    let request_id = string(c, "request_id")?;
    let fingerprint = yoneda_core::fingerprint(
        &json!({"run_id":c["run_id"],"expected_commit":c["expected_commit"],"expected_version":c["expected_version"],"expected_plan_revision":c["expected_plan_revision"],"task_ids":c["task_ids"],"expected_task_revisions":c["expected_task_revisions"],"owner_brief":c["owner_brief"]}),
    )?;
    if let Some(receipts) = run["team_repair_receipts"].as_array() {
        if let Some(previous) = receipts.iter().find(|v| v["request_id"] == request_id) {
            if previous["fingerprint"] != fingerprint {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Repair request ID was reused with different input",
                ));
            }
            return Ok(previous["receipt"].clone());
        }
    }
    let repository = repo(db)?;
    if repository["status"] != "ready"
        || !repository["pending"].is_null()
        || repository["head_commit"] != c["expected_commit"]
        || repository["version"] != c["expected_version"]
        || run["base"]["commit"] != repository["head_commit"]
    {
        return Err(Error::new(
            "HEAD_MOVED",
            "Repair requires its reserved canonical head and version",
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
    let brief = string(c, "owner_brief")?;
    if brief.len() > 4096 {
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
    for local in &selected {
        let task = tasks
            .iter()
            .find(|t| t["task_id"] == *local)
            .ok_or_else(|| Error::new("NOT_FOUND", "Unknown team task"))?;
        if task["revision"] != c["expected_task_revisions"][local] {
            return Err(Error::new("TASK_MOVED", "A selected task revision changed"));
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
    amendments.push(json!({"plan_revision":next_plan,"supersedes_revision":run["team_plan_revision"],"repair_round":next_round,"selected_tasks":selected,"expected_task_revisions":task_revisions,"owner_brief":brief,"approved_by":"repository_owner","created_at":now}));
    run["team_plan_revision"] = json!(next_plan);
    run["team_repair_rounds"] = json!(next_round);
    run["team_repair_brief"] = json!(brief);
    run["team_plan_amendments"] = json!(amendments);
    run["status"] = json!("exploring");
    let receipt = json!({"run_id":rid,"plan_revision":next_plan,"repair_round":next_round,"affected_tasks":affected,"status":"repairing"});
    let mut receipts = run["team_repair_receipts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    receipts.push(json!({"request_id":request_id,"fingerprint":fingerprint,"receipt":receipt}));
    run["team_repair_receipts"] = json!(receipts);
    save(db, "runs", &rid, &run)?;
    for mut task in tasks
        .into_iter()
        .filter(|t| affected.contains(t["task_id"].as_str().unwrap_or_default()))
    {
        supersede_task_attempts(db, &rid, &task, now)?;
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
            task["owner_brief"] = json!(brief);
            let original = task["instructions"].as_str().unwrap_or_default();
            task["instructions"] = json!(format!(
                "{original}\n\nOwner-approved repair brief: {brief}"
            ));
        }
        save(db, "team_tasks", &string(&task, "id")?, &task)?;
    }
    event(
        db,
        "team.repair_approved",
        now,
        json!({"run_id":rid,"plan_revision":next_plan,"round":next_round,"tasks":affected,"owner_brief":brief}),
    )?;
    scheduling::wake(db, &run, now)?;
    Ok(receipt)
}

fn supersede_task_attempts<S: SqlStore>(
    db: &S,
    run_id: &str,
    task: &Value,
    now: i64,
) -> Result<()> {
    let id = string(task, "id")?;
    for mut job in run_jobs(db, run_id)? {
        let task_job = job["payload"]["execution"]["team_task"] == id
            || (job["kind"] == "evaluate" && job["payload"]["candidate"]["execution"] == id);
        if task_job {
            cancel_job(db, &mut job, now)?;
            let jid = string(&job, "id")?;
            let mut latest = get(db, "jobs", &jid)?;
            if latest["status"] != "cancelled" {
                latest["status"] = json!("cancelled");
                latest["epoch"] = json!(
                    number(&latest, "epoch")?
                        .checked_add(1)
                        .ok_or_else(|| bad("Attempt epoch overflow"))?
                );
                save(db, "jobs", &jid, &latest)?;
            }
        }
    }
    if let Ok(mut execution) = get(db, "executions", &id) {
        execution["status"] = json!("cancelled");
        execution["error"] = json!("Superseded by owner-approved team repair");
        save_execution(db, &execution, now)?;
    }
    for mut candidate in all(db, "candidates")?
        .into_iter()
        .filter(|v| v["execution"] == id)
    {
        if db
            .query(
                "SELECT id FROM decisions WHERE json_extract(payload,'$.candidate')=? LIMIT 1",
                &[candidate["id"].clone()],
            )?
            .is_empty()
        {
            candidate["status"] = json!("stale");
            save(db, "candidates", &string(&candidate, "id")?, &candidate)?;
        }
    }
    for mut handoff in rows(db, "team_handoffs", run_id)?
        .into_iter()
        .filter(|h| h["execution_id"] == id && h["authority"] == "captured_revision")
    {
        handoff["authority"] = json!("superseded");
        save(db, "team_handoffs", &string(&handoff, "id")?, &handoff)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{execute, native::NativeStore};

    fn start(db: &NativeStore) {
        execute(db, json!({"op":"init","now":10,"id":"repair-repo","name":"Repair","remote":{"namespace":"test","name":"repair"},"commit":"a".repeat(40),"policy":{"version":"repair-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","public/index.js"],"timeout_seconds":30}]}}})).unwrap();
        execute(db, json!({"op":"start_run","now":11,"id":"repair-run","intent":"Build with a bounded team","mode":"collaborate","agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"worker"},{"provider":"zai","model":"glm-5.3-flash","strategy":"integrator"}],"team":{"version":1,"contract":"One shared API","integrator_agent":1,"integration_paths":["src/"],"tasks":[{"id":"upstream","title":"Upstream","instructions":"Implement upstream","agent":0,"depends_on":[],"write_paths":["src/upstream.rs"]},{"id":"downstream","title":"Downstream","instructions":"Use upstream","agent":0,"depends_on":["upstream"],"write_paths":["src/downstream.rs"]},{"id":"independent","title":"Independent","instructions":"Independent work","agent":0,"depends_on":[],"write_paths":["src/independent.rs"]}]}})).unwrap();
        for (local, agent, deps) in [
            ("upstream", 0, json!([])),
            ("downstream", 0, json!(["upstream"])),
            ("independent", 0, json!([])),
            (
                "integrate",
                1,
                json!(["upstream", "downstream", "independent"]),
            ),
        ] {
            let id = format!("repair-run:task:{local}");
            let mut task = get(db, "team_tasks", &id).unwrap();
            task["status"] = json!("complete");
            task["output"] = json!({"task_id":local,"execution_id":id,"paths":[format!("src/{local}.rs")],"revision":{"commit":"b".repeat(40)},"handoff_id":format!("handoff:{local}")});
            task["agent"] = json!(agent);
            task["depends_on"] = deps;
            save(db, "team_tasks", &id, &task).unwrap();
        }
        let mut run = get(db, "runs", "repair-run").unwrap();
        run["status"] = json!("ready");
        save(db, "runs", "repair-run", &run).unwrap();
        create(db,"evaluations","old-evaluation",&json!({"id":"old-evaluation","candidate":"old-candidate","checks":[{"status":"fail"}]})).unwrap();
        create(db,"candidates","old-candidate",&json!({"id":"old-candidate","execution":"repair-run:task:integrate","run_id":"repair-run","status":"rejected","evaluation":"old-evaluation"})).unwrap();
    }

    #[test]
    fn owner_repair_after_integration_failure_preserves_unaffected_and_fences_old_revision() {
        let db = NativeStore::memory().unwrap();
        start(&db);
        let before = get(&db, "team_tasks", "repair-run:task:downstream").unwrap();
        let independent_before = get(&db, "team_tasks", "repair-run:task:independent").unwrap();
        let request = json!({"op":"repair_team","request_id":"repair-1","expected_commit":"a".repeat(40),"expected_version":0,"run_id":"repair-run","expected_plan_revision":1,"task_ids":["upstream"],"expected_task_revisions":{"upstream":1},"owner_brief":"Correct the upstream behavior"});
        let result = repair(&db, &request, 20).unwrap();
        assert_eq!(result["repair_round"], 1);
        assert_eq!(repair(&db, &request, 21).unwrap(), result);
        let mut changed = request.clone();
        changed["owner_brief"] = json!("Changed input");
        assert_eq!(
            repair(&db, &changed, 22).unwrap_err().code,
            "IDEMPOTENCY_CONFLICT"
        );
        assert_eq!(
            get(&db, "team_tasks", "repair-run:task:upstream").unwrap()["revision"],
            2
        );
        let downstream = get(&db, "team_tasks", "repair-run:task:downstream").unwrap();
        assert_eq!(downstream["status"], "blocked");
        assert!(downstream["output"].is_null());
        assert_eq!(before["revision"], 1);
        assert_eq!(
            get(&db, "team_tasks", "repair-run:task:independent").unwrap()["output"],
            independent_before["output"]
        );
        assert_eq!(
            get(&db, "team_tasks", "repair-run:task:integrate").unwrap()["status"],
            "blocked"
        );
        assert_eq!(
            get(&db, "candidates", "old-candidate").unwrap()["status"],
            "stale"
        );
        assert_eq!(
            get(&db, "evaluations", "old-evaluation").unwrap()["checks"][0]["status"],
            "fail"
        );
        assert_eq!(
            get(&db, "runs", "repair-run").unwrap()["team_plan_revision"],
            2
        );
        let stale_job = json!({"payload":{"execution":{"id":"repair-run:task:upstream","run_id":"repair-run","team_task":"repair-run:task:upstream","team_task_revision":1}},"epoch":1});
        assert_eq!(
            super::super::captured(&db, &stale_job, &json!({"paths":[]}), 21)
                .unwrap_err()
                .code,
            "FENCED"
        );
    }

    #[test]
    fn repair_budget_is_two_rounds_and_does_not_revise_run_model_budgets() {
        let db = NativeStore::memory().unwrap();
        start(&db);
        let budgets = get(&db, "runs", "repair-run").unwrap()["model_budgets"].clone();
        let first = json!({"op":"repair_team","request_id":"repair-1","expected_commit":"a".repeat(40),"expected_version":0,"run_id":"repair-run","expected_plan_revision":1,"task_ids":["upstream"],"expected_task_revisions":{"upstream":1},"owner_brief":"First repair"});
        repair(&db, &first, 20).unwrap();
        let second = json!({"op":"repair_team","request_id":"repair-2","expected_commit":"a".repeat(40),"expected_version":0,"run_id":"repair-run","expected_plan_revision":2,"task_ids":["upstream"],"expected_task_revisions":{"upstream":2},"owner_brief":"Second repair"});
        repair(&db, &second, 30).unwrap();
        assert_eq!(
            get(&db, "runs", "repair-run").unwrap()["model_budgets"],
            budgets
        );
        let third = json!({"op":"repair_team","request_id":"repair-3","expected_commit":"a".repeat(40),"expected_version":0,"run_id":"repair-run","expected_plan_revision":3,"task_ids":["upstream"],"expected_task_revisions":{"upstream":3},"owner_brief":"Third repair"});
        assert_eq!(
            repair(&db, &third, 40).unwrap_err().code,
            "REPAIR_BUDGET_EXHAUSTED"
        );
    }
}
