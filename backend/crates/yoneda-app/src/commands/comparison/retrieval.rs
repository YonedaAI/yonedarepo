//! Reviewer graph reads are restricted before pagination to frozen manifest references.
use super::*;
pub(in crate::commands) fn guard<S: SqlStore>(db: &S, c: &Value) -> Result<()> {
    if c.get("job_id").is_none() {
        return Ok(());
    }
    let op = string(c, "op")?;
    if [
        "context_publish",
        "publish_artifact",
        "delegate_agent",
        "hint_complete",
        "team_plan_propose",
        "task_handoff",
        "integration_request",
        "retry_team_task",
        "repair_request",
        "repair_team",
        "peer_message",
        "intent_question",
    ]
    .contains(&op.as_str())
    {
        let job = get(db, "jobs", &string(c, "job_id")?)?;
        if job["payload"]["comparison_review"] == true {
            return Err(Error::new(
                "FORBIDDEN",
                "Comparison reviewers may only submit the scoped review result",
            ));
        }
    }
    Ok(())
}
pub(in crate::commands) fn read<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Option<Value>> {
    if c.get("job_id").is_none() {
        return Ok(None);
    }
    let job = active(db, c, now)?;
    if job["payload"]["comparison_review"] != true {
        return Ok(None);
    }
    let run = get(db, "runs", &string(&job["payload"]["execution"], "run_id")?)?;
    authorize_execution(&run, &job)?;
    let frozen = &job["payload"]["comparison_manifest"];
    let mut records = run["comparison"]["approval"]["context_records"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut ids = run["comparison"]["approval"]["context"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    ids.push(json!(format!("intent:{}", string(&run, "id")?)));
    for alternative in frozen["manifest"]["alternatives"]
        .as_array()
        .into_iter()
        .flatten()
    {
        ids.extend(
            alternative["evidence_refs"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
    }
    for id in ids.iter().filter_map(Value::as_str) {
        if records.iter().any(|r| r["id"] == id) {
            continue;
        }
        match get(db, "nodes", id) {
            Ok(record) => records.push(record),
            Err(e) if e.code == "NOT_FOUND" => {}
            Err(e) => return Err(e),
        }
    }
    if c["op"] == "context_get" {
        let id = string(c, "id")?;
        return records
            .into_iter()
            .find(|r| r["id"] == id)
            .map(Some)
            .ok_or_else(|| {
                Error::new(
                    "FORBIDDEN",
                    "Context is outside the frozen comparison manifest",
                )
            });
    }
    let query = c["query"].as_str().unwrap_or("");
    let limit = c["limit"].as_u64().unwrap_or(25);
    if query.len() > 512 || !(1..=50).contains(&limit) {
        return Err(bad("Bounded reviewer context query required"));
    }
    let fingerprint = yoneda_core::fingerprint(
        &json!({"manifest":frozen["manifest_digest"],"query":query,"kind":c["kind"],"file_path":c["file_path"],"authority":c["authority"],"lineage":c["lineage"]}),
    )?;
    let cursor = c["cursor"].as_str().unwrap_or("");
    let offset = if cursor.is_empty() {
        0
    } else {
        if cursor.len() > 256 {
            return Err(bad("Context cursor exceeds bounds"));
        }
        let parsed: Value =
            serde_json::from_str(cursor).map_err(|_| bad("Invalid context cursor"))?;
        if parsed["fingerprint"] != fingerprint {
            return Err(bad("Context cursor query changed"));
        }
        parsed["offset"]
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .filter(|v| *v <= 200)
            .ok_or_else(|| bad("Invalid context offset"))?
    };
    let terms = query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    records.retain(|r| {
        let text = format!(
            "{} {} {} {}",
            r["id"].as_str().unwrap_or(""),
            r["label"].as_str().unwrap_or(""),
            r["data"]["statement"].as_str().unwrap_or(""),
            r["data"]["purpose"].as_str().unwrap_or("")
        )
        .to_lowercase();
        terms.iter().all(|t| text.contains(t))
            && c["kind"].as_str().is_none_or(|kind| r["kind"] == kind)
    });
    records.sort_by_key(|r| r["id"].as_str().unwrap_or("").to_owned());
    records.dedup_by(|a, b| a["id"] == b["id"]);
    let count = usize::try_from(limit).map_err(|_| bad("Invalid context limit"))?;
    let items = records
        .iter()
        .skip(offset)
        .take(count)
        .cloned()
        .collect::<Vec<_>>();
    let cursor = (offset + items.len() < records.len())
        .then(|| json!({"fingerprint":fingerprint,"offset":offset+items.len()}).to_string());
    Ok(Some(
        json!({"items":items,"next_cursor":cursor,"bounded":true,"coverage":"frozen comparison manifest context"}),
    ))
}
