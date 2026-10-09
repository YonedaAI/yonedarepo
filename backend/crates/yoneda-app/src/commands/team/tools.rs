//! Scoped agent tools expose one assigned task. Handoff text remains an assertion.
use super::*;
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let job = active(db, c, now)?;
    let execution = &job["payload"]["execution"];
    if c["op"] == "team_context" && execution["team_role"] == "planner" {
        return super::planning::context(db, c, now);
    }
    if job["kind"] != "agent" || job["external"] == true || execution["team_task"].is_null() {
        return Err(Error::new(
            "FORBIDDEN",
            "Team tools require a hosted team task attempt",
        ));
    }
    let task = get(db, "team_tasks", &string(execution, "team_task")?)?;
    let run = get(db, "runs", &string(execution, "run_id")?)?;
    if task["revision"] != execution["team_task_revision"] {
        return Err(Error::new("FENCED", "Team task version changed"));
    }
    match c["op"].as_str().unwrap_or_default() {
        "team_context" => {
            let inputs = &job["payload"]["team_inputs"];
            let handoffs = inputs
                .as_array()
                .into_iter()
                .flatten()
                .map(|input| get(db, "team_handoffs", &string(input, "handoff_id")?))
                .collect::<Result<Vec<_>>>()?;
            Ok(
                json!({"run_id":run["id"],"mode":"collaborate","plan_revision":run["team_plan_revision"],"contract":run["team_plan"]["contract"],"base":run["base"],"task":task,"inputs":inputs,"handoffs":handoffs,"integration_manifest":job["payload"]["integration_manifest"],"integration_digest":job["payload"]["integration_digest"],"manifest_record":job["payload"]["manifest_record"]}),
            )
        }
        "integration_request" => {
            if execution["team_role"] != "integrator" {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Only the designated integrator receives an integration manifest",
                ));
            }
            let current = inputs::manifest(db, &run)?;
            if current != job["payload"]["integration_manifest"] {
                return Err(Error::new(
                    "STALE_INTEGRATION",
                    "Integration inputs changed",
                ));
            }
            Ok(
                json!({"manifest":current,"digest":job["payload"]["integration_digest"],"authority":"captured_inputs","manifest_record":job["payload"]["manifest_record"]}),
            )
        }
        "task_handoff" => {
            let summary = string(c, "summary")?;
            let contract = string(c, "interface_contract")?;
            if summary.len() > 8192
                || contract.len() > 8192
                || summary.contains('\0')
                || contract.contains('\0')
            {
                return Err(bad("Handoff assertions must be bounded text"));
            }
            let references = c["references"]
                .as_array()
                .ok_or_else(|| bad("Handoff references must be an array"))?;
            if references.len() > 32 {
                return Err(bad("At most 32 handoff references"));
            }
            let mut links = Vec::new();
            for reference in references {
                let target = reference
                    .as_str()
                    .ok_or_else(|| bad("References must be context IDs"))?;
                get(db, "nodes", target)?;
                links.push(json!({"relation":"supports","target":target}));
            }
            let data = json!({"summary":summary,"interface_contract":contract,"references":references,"links":links,"epoch":job["epoch"],"authority":"assertion"});
            let fingerprint = yoneda_core::fingerprint(&data)?;
            let id = format!(
                "handoff-assertion:{}:{}:{fingerprint}",
                string(execution, "id")?,
                number(&job, "epoch")?
            );
            if let Ok(handoff) = get(db, "team_handoffs", &id) {
                return Ok(handoff);
            }
            let handoff = json!({"id":id,"run_id":run["id"],"task_id":task["task_id"],"execution_id":execution["id"],"epoch":job["epoch"],"authority":"assertion","summary":summary,"interface_contract":contract,"references":references,"created_at":now});
            create(db, "team_handoffs", &id, &handoff)?;
            node(
                db,
                &id,
                "finding",
                &summary,
                &string(execution, "id")?,
                now,
                data,
            )?;
            edge(
                db,
                &string(execution, "id")?,
                &id,
                "produced_by",
                "agent handoff assertion; source capture still required",
            )?;
            for reference in references.iter().filter_map(Value::as_str) {
                edge(db, &id, reference, "supports", "explicit agent citation")?;
            }
            event(
                db,
                "context.published",
                now,
                json!({"id":id,"run_id":run["id"],"execution":execution["id"],"epoch":job["epoch"]}),
            )?;
            Ok(handoff)
        }
        _ => Err(Error::new("NOT_FOUND", "Unknown team operation")),
    }
}
