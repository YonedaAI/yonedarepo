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
            validate_assumptions(&c["metadata"], execution["role"] == "research")?;
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
        "authorize_artifact" | "get_artifact" => {
            let j = active(db, &c, now)?;
            let requested = string(&c, "id")?;
            let execution = &j["payload"]["execution"];
            if j["kind"] != "agent" {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Artifact is outside the frozen execution context",
                ));
            }
            // Resolve aliases only against this attempt's frozen allowlist.
            let id = execution["context"]
                .as_array()
                .and_then(|allowed| {
                    allowed
                        .iter()
                        .filter_map(Value::as_str)
                        .find(|id| *id == requested)
                        .or_else(|| {
                            allowed
                                .iter()
                                .filter_map(Value::as_str)
                                .find(|id| id.strip_prefix("artifact:") == Some(requested.as_str()))
                        })
                })
                .ok_or_else(|| {
                    Error::new(
                        "FORBIDDEN",
                        "Artifact is outside the frozen execution context",
                    )
                })?
                .to_owned();
            let a = get(db, "artifacts", &id)?;
            if c["op"] == "authorize_artifact" {
                return Ok(a);
            }
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
                json!({"artifact":id,"execution":eid,"epoch":j["epoch"]}),
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

fn validate_assumptions(metadata: &Value, research: bool) -> Result<()> {
    let assumptions = metadata["assumptions"].as_array();
    if research && assumptions.is_none_or(Vec::is_empty) {
        return Err(bad(
            r#"Research requires metadata.assumptions: [{"statement":"Upstream p99 stays within 100 ms","metric":"upstream_p99_ms","limit":100,"path":"src/main.rs"}]. Use an array, a string metric and an integer limit; keep the original assertion explicit."#,
        ));
    }
    if !metadata["assumptions"].is_null() && assumptions.is_none() {
        return Err(bad("metadata.assumptions must be an array"));
    }
    if let Some(assumptions) = assumptions {
        if assumptions.len() > 32 {
            return Err(bad("At most 32 assumptions per artifact"));
        }
        for assumption in assumptions {
            string(assumption, "statement")?;
            let metric = string(assumption, "metric")?;
            if metric.len() > 128 {
                return Err(bad("Metric name is too long"));
            }
            number(assumption, "limit")?;
            yoneda_core::validate_path(&string(assumption, "path")?)?;
        }
    }
    Ok(())
}
