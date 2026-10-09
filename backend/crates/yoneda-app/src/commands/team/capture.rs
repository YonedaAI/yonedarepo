//! Only trusted source capture completes specialist tasks and creates dependency versions.
use super::*;
use yoneda_core::team::owns_path;

pub(super) fn captured<S: SqlStore>(db: &S, job: &Value, result: &Value, now: i64) -> Result<bool> {
    let execution = &job["payload"]["execution"];
    let Some(id) = execution["team_task"].as_str() else {
        return Ok(false);
    };
    let mut task = get(db, "team_tasks", id)?;
    let run = get(db, "runs", &string(&task, "run_id")?)?;
    if task["revision"] != execution["team_task_revision"] || task["status"] != "capturing" {
        return Err(Error::new(
            "FENCED",
            "Team task capture belongs to a replaced or inactive attempt",
        ));
    }
    let paths = result["paths"]
        .as_array()
        .ok_or_else(|| bad("Capture must enumerate paths"))?;
    let scopes = job["payload"]["team_write_paths"]
        .as_array()
        .ok_or_else(|| bad("Capture is missing trusted team scope"))?;
    for path in paths {
        let path = path.as_str().ok_or_else(|| bad("Invalid changed path"))?;
        yoneda_core::validate_path(path)?;
        if !scopes
            .iter()
            .filter_map(Value::as_str)
            .any(|scope| owns_path(scope, path))
        {
            return Err(Error::new(
                "WRITE_SCOPE",
                "Captured source includes a path outside the frozen team scope",
            ));
        }
    }
    if execution["team_role"] == "integrator" {
        let manifest = inputs::manifest(db, &run)?;
        let digest = yoneda_core::fingerprint(&manifest)?;
        if job["payload"]["integration_manifest"] != manifest
            || job["payload"]["integration_digest"] != digest
            || result["integration_digest"] != digest
        {
            return Err(Error::new(
                "STALE_INTEGRATION",
                "Trusted capture must attest the exact integration input manifest",
            ));
        }
        task["status"] = json!("evaluating");
        task["candidate_id"] = result["id"].clone();
        save(db, "team_tasks", id, &task)?;
        edge(
            db,
            &string(&job["payload"]["manifest_record"], "id")?,
            &string(result, "id")?,
            "captured_as",
            &digest,
        )?;
        for input in manifest["inputs"].as_array().into_iter().flatten() {
            edge(
                db,
                &string(input, "handoff_id")?,
                &string(result, "id")?,
                "integrated_into",
                &digest,
            )?;
        }
        return Ok(false);
    }
    let owned: Vec<Value> = paths
        .iter()
        .filter(|p| {
            p.as_str().is_some_and(|p| {
                task["write_paths"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .any(|scope| owns_path(scope, p))
            })
        })
        .cloned()
        .collect();
    let handoff_id = format!("handoff:{id}:{}", number(&task, "revision")?);
    let assertions: Vec<Value> = rows(db, "team_handoffs", &string(&task, "run_id")?)?
        .into_iter()
        .filter(|h| {
            h["task_id"] == task["task_id"]
                && h["authority"] == "assertion"
                && h["epoch"] == task["epoch"]
        })
        .collect();
    let output = json!({"task_id":task["task_id"],"task_revision":task["revision"],"execution_id":id,"revision":result["revision"],"tree":result["tree"],"paths":owned,"write_paths":task["write_paths"],"capture_paths":paths,"capture_job":job["id"],"capture_epoch":job["epoch"],"handoff_id":handoff_id});
    let handoff = json!({"id":handoff_id,"run_id":task["run_id"],"task_id":task["task_id"],"execution_id":id,"epoch":task["epoch"],"authority":"captured_revision","output":output,"assertions":assertions,"created_at":now});
    create(db, "team_handoffs", &handoff_id, &handoff)?;
    node(
        db,
        &handoff_id,
        "team_handoff",
        &string(&task, "title")?,
        "platform_capture",
        now,
        handoff.clone(),
    )?;
    edge(
        db,
        id,
        &handoff_id,
        "produced_by",
        "trusted task source capture",
    )?;
    edge(
        db,
        &format!("team-task:{id}"),
        &handoff_id,
        "captured_as",
        &string(result, "tree")?,
    )?;
    for input in job["payload"]["team_inputs"]
        .as_array()
        .into_iter()
        .flatten()
    {
        edge(
            db,
            &string(input, "handoff_id")?,
            &handoff_id,
            "continued_by",
            "exact captured prerequisite input",
        )?;
    }
    task["status"] = json!("complete");
    task["output"] = output;
    task["completed_at"] = json!(now);
    save(db, "team_tasks", id, &task)?;
    let mut e = get(db, "executions", id)?;
    e["status"] = json!("completed");
    save_execution(db, &e, now)?;
    event(db, "team.task_captured", now, handoff)?;
    scheduling::wake(db, &run, now)?;
    Ok(true)
}
