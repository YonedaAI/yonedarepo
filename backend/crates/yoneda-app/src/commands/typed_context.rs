use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, context::ContextInput};

pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    // The Worker owns owner authentication. An attempt always derives its identity from its lease.
    let attempt = if c.get("job_id").is_some() {
        let job = active(db, &c, now)?;
        if job["kind"] != "agent" {
            return Err(Error::new(
                "FORBIDDEN",
                "Only agent attempts use context tools",
            ));
        }
        Some(job)
    } else {
        None
    };
    match string(&c, "op")?.as_str() {
        "context_publish" => {
            let mut input = c["record"].clone();
            if let Some(job) = &attempt
                && job["external"] != true
                && let Some(record) = input.as_object_mut()
            {
                let run_id = string(&job["payload"]["execution"], "run_id")?;
                // A hosted attempt already has an assigned intent. Accept its exact
                // run-ID alias without changing an explicit different intent.
                if !record.contains_key("intent_id") || record["intent_id"] == run_id {
                    record.insert("intent_id".into(), json!(format!("intent:{run_id}")));
                }
            }
            let record: ContextInput =
                serde_json::from_value(input).map_err(|e| bad(&e.to_string()))?;
            record.validate()?;
            if let Some(job) = &attempt
                && record.intent_id
                    != format!("intent:{}", string(&job["payload"]["execution"], "run_id")?)
            {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Attempt must contribute to its assigned intent",
                ));
            }
            let intent = get(db, "nodes", &record.intent_id)?;
            if intent["kind"] != "intent" {
                return Err(bad("Context intent must reference an intent node"));
            }
            for link in &record.links {
                get(db, "nodes", &link.target)?;
            }
            let author = match &attempt {
                Some(job) => string(&job["payload"]["execution"], "id")?,
                None => "owner".into(),
            };
            let value = json!({"id":record.id,"kind":record.kind.as_str(),"label":record.statement,"author":author,"recorded_at":now,"data":{"statement":record.statement,"purpose":record.purpose,"intent_id":record.intent_id,"links":record.links,"authority":"assertion","epoch":attempt.as_ref().map(|job| &job["epoch"])}});
            create(db, "nodes", &record.id, &value)?;
            edge(
                db,
                &record.id,
                &record.intent_id,
                "addresses",
                "declared intent",
            )?;
            for link in &record.links {
                edge(
                    db,
                    &record.id,
                    &link.target,
                    link.relation.as_str(),
                    "agent or owner assertion",
                )?;
            }
            if attempt.is_some() {
                edge(
                    db,
                    &author,
                    &record.id,
                    "contributed",
                    "identity from active attempt",
                )?;
            }
            event(db, "context.published", now, value.clone())?;
            Ok(value)
        }
        "context_get" => get(db, "nodes", &string(&c, "id")?),
        "context_search" => {
            let query = c.get("query").and_then(Value::as_str).unwrap_or("");
            let cursor = c.get("cursor").and_then(Value::as_str).unwrap_or("");
            let limit = c.get("limit").and_then(Value::as_i64).unwrap_or(25);
            if query.len() > 512 || cursor.len() > 256 || !(1..=50).contains(&limit) {
                return Err(bad(
                    "Context search limit is 1–50 with bounded query and cursor",
                ));
            }
            let kind = c.get("kind").and_then(Value::as_str).unwrap_or("");
            if !kind.is_empty() {
                serde_json::from_value::<yoneda_core::context::ContextKind>(json!(kind))
                    .map_err(|_| bad("Unknown context kind"))?;
            }
            let rows = db.query("SELECT id,payload FROM nodes WHERE id>? AND json_extract(payload,'$.kind') IN ('intent','requirement','constraint','assumption','finding','alternative','proposed_decision','question') AND instr(lower(json_extract(payload,'$.label')),lower(?))>0 AND (?='' OR json_extract(payload,'$.kind')=?) ORDER BY id LIMIT ?", &[json!(cursor),json!(query),json!(kind),json!(kind),json!(limit + 1)])?;
            let more = rows.len() > usize::try_from(limit).map_err(|_| bad("Invalid limit"))?;
            let mut items = Vec::new();
            for row in rows
                .iter()
                .take(usize::try_from(limit).map_err(|_| bad("Invalid limit"))?)
            {
                items.push(
                    serde_json::from_str::<Value>(
                        row["payload"]
                            .as_str()
                            .ok_or_else(|| bad("Corrupt context"))?,
                    )
                    .map_err(|e| bad(&e.to_string()))?,
                );
            }
            let next_cursor = if more {
                items.last().map(|v| v["id"].clone()).unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            Ok(json!({"items":items,"next_cursor":next_cursor}))
        }
        _ => Err(bad("Unknown context operation")),
    }
}
