use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "context" => {
            let j = active(db, &c, now)?;
            if j["kind"] != "agent" {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Context tools are for coding harnesses",
                ));
            }
            Ok(j["payload"].clone())
        }
        "publish_artifact" => {
            let j = active(db, &c, now)?;
            if j["kind"] != "agent" {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Only agents publish context artifacts",
                ));
            }
            let id = string(&c, "id")?;
            let digest = hash(&c, "digest", &[64])?;
            let label = string(&c, "label")?;
            let kind = string(&c, "kind")?;
            let execution = &j["payload"]["execution"];
            let producer = string(execution, "id")?;
            let run_id = string(execution, "run_id")?;
            let a = json!({"id":id,"run_id":run_id,"producer":producer,"kind":kind,"label":label,"digest":digest,"metadata":c.get("metadata").cloned().unwrap_or(json!({}))});
            create(db, "artifacts", &id, &a)?;
            node(
                db,
                &id,
                "context",
                &label,
                "agent_assertion",
                now,
                a.clone(),
            )?;
            edge(db, &producer, &id, "produced_by", &digest)?;
            if let Some(assumptions) = a["metadata"]["assumptions"].as_array() {
                for (i, assumption) in assumptions.iter().enumerate() {
                    let aid = format!("assumption:{id}:{i}");
                    let statement = string(assumption, "statement")?;
                    node(
                        db,
                        &aid,
                        "assumption",
                        &statement,
                        "agent_assertion",
                        now,
                        assumption.clone(),
                    )?;
                    edge(db, &id, &aid, "states", &digest)?;
                }
            }
            event(db, "artifact.published", now, a.clone())?;
            Ok(a)
        }
        "get_artifact" => {
            let j = active(db, &c, now)?;
            let id = string(&c, "id")?;
            let execution = &j["payload"]["execution"];
            if j["kind"] != "agent"
                || !execution["context"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == &json!(id)))
            {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Artifact is outside the frozen execution context",
                ));
            }
            let a = get(db, "artifacts", &id)?;
            let eid = string(execution, "id")?;
            edge(
                db,
                &id,
                &eid,
                "retrieved_by",
                a["digest"].as_str().unwrap_or_default(),
            )?;
            event(
                db,
                "artifact.retrieved",
                now,
                json!({"artifact":id,"execution":eid}),
            )?;
            Ok(a)
        }
        "hint_complete" => {
            let mut j = active(db, &c, now)?;
            j["completion_hint"] = c.get("summary").cloned().unwrap_or(json!(""));
            let id = string(&j, "id")?;
            save(db, "jobs", &id, &j)?;
            Ok(json!({"status":"capture_requested","authoritative":false}))
        }
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
}
