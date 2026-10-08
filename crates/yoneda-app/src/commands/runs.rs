use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "start_run" => {
            let r = repo(db)?;
            if !r["pending"].is_null() {
                return Err(Error::new(
                    "PUBLICATION_PENDING",
                    "Wait for verified publication before starting another run",
                ));
            }
            if r["status"] != "ready" {
                return Err(Error::new(
                    "REPOSITORY_BLOCKED",
                    "Resolve remote divergence before starting work",
                ));
            }
            let id = string(&c, "id")?;
            let intent = string(&c, "intent")?;
            let general = !r["policy"]["build"].is_null();
            let criteria = c.get("criteria").cloned().unwrap_or(json!([]));
            let criteria_array = criteria
                .as_array()
                .ok_or_else(|| bad("Criteria must be an array"))?;
            if criteria_array.len() > 32
                || criteria_array.iter().any(|v| {
                    v.as_str()
                        .is_none_or(|s| s.trim().is_empty() || s.len() > 2048)
                })
            {
                return Err(bad("Criteria must be bounded statements"));
            }
            let context = c.get("context").cloned().unwrap_or(json!([]));
            let references = context
                .as_array()
                .ok_or_else(|| bad("Context must be an array"))?;
            if references.len() > 50 {
                return Err(bad("At most 50 context records per run"));
            }
            let mut records = Vec::new();
            for reference in references {
                records.push(get(
                    db,
                    "nodes",
                    reference
                        .as_str()
                        .ok_or_else(|| bad("Invalid context ID"))?,
                )?);
            }
            if general {
                super::scheduling::validate_agents(&c)?;
            }
            if all(db, "runs")?.len() >= 100 {
                return Err(Error::new(
                    "REPOSITORY_LIMIT",
                    "MVP repository supports 100 retained runs",
                ));
            }
            let remote = format!(
                "{}/{}",
                string(&r["remote"], "namespace")?,
                string(&r["remote"], "name")?
            );
            let run = json!({"id":id,"intent":intent,"criteria":criteria,"context":context,"context_records":records,"policy":r["policy"],"base":{"repository":remote,"commit":r["published_commit"]},"base_version":r["version"],"status":if general {"exploring"} else {"researching"},"created_at":now});
            create(db, "runs", &id, &run)?;
            let intent_id = format!("intent:{id}");
            node(
                db,
                &intent_id,
                "intent",
                &intent,
                "owner",
                now,
                json!({"criteria":run["criteria"]}),
            )?;
            node(db, &id, "run", &intent, "platform", now, run.clone())?;
            edge(db, &intent_id, &id, "implements", "owner request")?;
            if general {
                super::scheduling::schedule(db, &run, &c["agents"], now)?;
            } else {
                execution(db, &run, "claude", "research", "research", json!([]), now)?;
            }
            event(db, "run.created", now, run.clone())?;
            Ok(run)
        }
        "cancel_run" => {
            let id = string(&c, "run_id")?;
            let mut r = get(db, "runs", &id)?;
            if r["status"] == "accepted" {
                return Err(Error::new(
                    "INVALID_STATE",
                    "Accepted runs cannot be cancelled",
                ));
            }
            r["status"] = json!("cancelled");
            save(db, "runs", &id, &r)?;
            let mut stops = Vec::new();
            for mut j in all(db, "jobs")? {
                let matches =
                    j["payload"]["execution"]["run_id"] == id || j["payload"]["run_id"] == id;
                if matches && (j["status"] == "queued" || j["status"] == "running") {
                    let jid = string(&j, "id")?;
                    stops.push(json!({"job_id":jid,"epoch":j["epoch"]}));
                    j["status"] = json!("cancelled");
                    j["epoch"] = json!(number(&j, "epoch")? + 1);
                    save(db, "jobs", &jid, &j)?;
                    if let Some(eid) = j["payload"]["execution"]["id"]
                        .as_str()
                        .or_else(|| j["payload"]["candidate"]["execution"].as_str())
                    {
                        let mut e = get(db, "executions", eid)?;
                        e["status"] = json!("cancelled");
                        save_execution(db, &e, now)?;
                    }
                    if let Some(cid) = j["payload"]["candidate"]["id"].as_str() {
                        let mut candidate = get(db, "candidates", cid)?;
                        candidate["status"] = json!("cancelled");
                        save(db, "candidates", cid, &candidate)?;
                    }
                }
            }
            event(db, "run.cancelled", now, json!({"id":id}))?;
            Ok(json!({"status":"cancelled","stop":stops}))
        }
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
}
