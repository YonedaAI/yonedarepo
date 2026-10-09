//! Join assertion provenance to independently captured/evaluated source, without upgrading claims.
use crate::storage::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::Result;

pub(super) fn target<S: SqlStore>(db: &S, id: &str, digest: Option<&str>) -> Result<Value> {
    let record = get(db, "nodes", id)?;
    let authority = match record["kind"].as_str().unwrap_or_default() {
        "candidate" | "team_handoff" => "captured_revision",
        "evaluation" => "checked_revision",
        "decision" => "recorded_decision",
        "source" => "source_revision",
        "execution" | "run" | "repository" | "team_task" | "integration_manifest" => {
            "platform_record"
        }
        _ => "assertion",
    };
    let canonical = digest.map(json_string).unwrap_or_else(|| {
        record["data"]
            .get("digest")
            .or_else(|| record["data"].get("evidence"))
            .cloned()
            .unwrap_or(Value::Null)
    });
    Ok(
        json!({"id":id,"digest":canonical,"kind":record["kind"],"label":record["label"],"authority":authority}),
    )
}
fn json_string(value: &str) -> Value {
    json!(value)
}

pub(super) fn checked<S: SqlStore>(db: &S, run: &str) -> Result<Vec<Value>> {
    let rows = db.query("SELECT e.payload FROM evaluations e JOIN candidates c ON json_extract(e.payload,'$.candidate')=c.id WHERE json_extract(c.payload,'$.run_id')=? ORDER BY e.id", &[json!(run)])?;
    let mut checked = Vec::new();
    for row in rows {
        let evaluation: Value = serde_json::from_str(
            row["payload"]
                .as_str()
                .ok_or_else(|| bad("Corrupt evaluation"))?,
        )
        .map_err(|_| bad("Corrupt evaluation"))?;
        let candidate = get(db, "candidates", &string(&evaluation, "candidate")?)?;
        if evaluation["revision"] != candidate["revision"] {
            continue;
        }
        checked.push(json!({"candidate_id":candidate["id"],"execution_id":candidate["execution"],
            "revision":evaluation["revision"],"evaluation_id":evaluation["id"],"evidence":evaluation["evidence"],
            "policy":evaluation["policy"],"checks":evaluation["checks"],"authority":"checked_revision"}));
    }
    Ok(checked)
}

pub(super) fn assigned<S: SqlStore>(
    db: &S,
    run: &Value,
    executions: &[Value],
) -> Result<(Vec<Value>, usize)> {
    let mut rows = Vec::new();
    let mut ids = BTreeSet::new();
    for execution in executions {
        let mut targets = Vec::new();
        let mut assigned: BTreeSet<&str> = execution["context"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let notes = (run["context_study"]["arm"] == "plain_notes")
            .then(|| run["context_study"]["records"].as_array())
            .flatten();
        if let Some(notes) = notes {
            assigned.extend(notes.iter().filter_map(|record| record["id"].as_str()));
        }
        for id in assigned {
            ids.insert(id.to_owned());
            let frozen = run["context_records"]
                .as_array()
                .and_then(|records| records.iter().find(|record| record["id"] == id))
                .or_else(|| {
                    notes.and_then(|records| records.iter().find(|record| record["id"] == id))
                });
            let mut entry = target(db, id, None)?;
            if let Some(record) = frozen {
                entry["kind"] = record["kind"].clone();
                entry["label"] = record["label"].clone();
            }
            targets.push(entry);
        }
        rows.push(json!({"execution_id":execution["id"],"stage":"assigned","targets":targets}));
    }
    Ok((rows, ids.len()))
}

pub(super) fn citations<S: SqlStore>(
    db: &S,
    executions: &[Value],
    checked: &[Value],
) -> Result<(Vec<Value>, usize, bool)> {
    if executions.is_empty() {
        return Ok((vec![], 0, false));
    }
    let placeholders = vec!["?"; executions.len()].join(",");
    let params: Vec<_> = executions
        .iter()
        .map(|execution| execution["id"].clone())
        .collect();
    let sql = format!(
        "SELECT payload FROM nodes WHERE json_extract(payload,'$.author') IN ({placeholders}) AND json_array_length(json_extract(payload,'$.data.links'))>0 ORDER BY id LIMIT 1001"
    );
    let rows = db.query(&sql, &params)?;
    let truncated = rows.len() > 1000;
    let mut result = Vec::new();
    for row in rows.into_iter().take(1000) {
        let node: Value = serde_json::from_str(
            row["payload"]
                .as_str()
                .ok_or_else(|| bad("Corrupt assertion"))?,
        )
        .map_err(|_| bad("Corrupt assertion"))?;
        let execution = string(&node, "author")?;
        let mut targets = Vec::new();
        for link in node["data"]["links"].as_array().into_iter().flatten() {
            let mut entry = target(db, &string(link, "target")?, None)?;
            entry["relation"] = link["relation"].clone();
            targets.push(entry);
        }
        let candidates = db.query("SELECT payload FROM candidates WHERE json_extract(payload,'$.execution')=? ORDER BY id", &[json!(execution)])?;
        let mut candidates: Vec<Value> = candidates.into_iter().map(|row| {
            let candidate: Value = serde_json::from_str(row["payload"].as_str().ok_or_else(|| bad("Corrupt candidate"))?).map_err(|_| bad("Corrupt candidate"))?;
            let evaluation = checked.iter().find(|evaluation| evaluation["candidate_id"] == candidate["id"] && evaluation["evaluation_id"] == candidate["evaluation"]);
            Ok(json!({"id":candidate["id"],"revision":candidate["revision"],"capture_job_id":candidate.get("capture_job").cloned().unwrap_or_else(||json!(format!("capture:{execution}"))),"evaluation":evaluation,"capture_kind":if candidate.get("integration_manifest").is_some(){json!("integration")}else{Value::Null}}))
        }).collect::<Result<_>>()?;
        candidates.extend(super::team::citation_sources(
            db,
            &execution,
            &node["data"]["epoch"],
            checked,
        )?);
        let sequence = db.query("SELECT seq FROM events WHERE kind='context.published' AND json_extract(data,'$.id')=? ORDER BY seq LIMIT 1", &[node["id"].clone()])?;
        result.push(json!({"record_id":node["id"],"execution_id":execution,"seq":sequence.first().map(|row| &row["seq"]),
            "at":node["recorded_at"],"epoch":node["data"]["epoch"],"authority":"assertion","targets":targets,"candidates":candidates}));
    }
    let count_sql = format!(
        "SELECT COUNT(DISTINCT json_extract(link.value,'$.target')) AS count FROM nodes,json_each(nodes.payload,'$.data.links') link WHERE json_extract(nodes.payload,'$.author') IN ({placeholders})"
    );
    let count = db.query(&count_sql, &params)?;
    let count =
        usize::try_from(number(&count[0], "count")?).map_err(|_| bad("Invalid citation count"))?;
    Ok((result, count, truncated))
}
