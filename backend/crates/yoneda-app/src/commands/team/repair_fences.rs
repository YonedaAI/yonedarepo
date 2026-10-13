//! Cancel every affected attempt and retain historical evidence.
use super::*;

pub(super) fn supersede_task_attempts<S: SqlStore>(
    db: &S,
    run_id: &str,
    task: &Value,
    now: i64,
) -> Result<()> {
    let id = string(task, "id")?;
    let executions = run_executions(db, run_id)?;
    let mut affected = BTreeSet::from([id.clone()]);
    for _ in 0..executions.len() {
        for execution in &executions {
            if ["source_execution", "parent_execution"].iter().any(|key| {
                execution[*key]
                    .as_str()
                    .is_some_and(|parent| affected.contains(parent))
            }) {
                affected.insert(string(execution, "id")?);
            }
        }
    }
    for mut job in run_jobs(db, run_id)? {
        let task_job = job["payload"]["execution"]["team_task"] == id
            || job["payload"]["execution"]["id"]
                .as_str()
                .is_some_and(|eid| affected.contains(eid))
            || job["payload"]["candidate"]["execution"]
                .as_str()
                .is_some_and(|eid| affected.contains(eid));
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
    for mut execution in executions
        .into_iter()
        .filter(|e| e["id"].as_str().is_some_and(|eid| affected.contains(eid)))
    {
        execution["status"] = json!("cancelled");
        execution["error"] = json!("Superseded by approved team repair");
        save_execution(db, &execution, now)?;
    }
    for mut candidate in all(db, "candidates")?.into_iter().filter(|v| {
        v["execution"]
            .as_str()
            .is_some_and(|eid| affected.contains(eid))
    }) {
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
    for mut conflict in all(db, "conflicts")?.into_iter().filter(|v| {
        v["resolver_execution_id"]
            .as_str()
            .is_some_and(|eid| affected.contains(eid))
    }) {
        conflict["status"] = json!("stale");
        save(db, "conflicts", &string(&conflict, "id")?, &conflict)?;
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
