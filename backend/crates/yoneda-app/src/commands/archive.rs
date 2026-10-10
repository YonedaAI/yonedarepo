use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "archive_candidates" => {
            let cutoff = now.saturating_sub(30 * DAY_MS);
            let rows=db.query("SELECT r.id FROM runs r LEFT JOIN archive_index a ON a.run_id=r.id WHERE a.run_id IS NULL AND json_extract(r.payload,'$.status') IN ('accepted','cancelled','failed','ready') AND CAST(json_extract(r.payload,'$.created_at') AS INTEGER)<=? ORDER BY json_extract(r.payload,'$.created_at'),r.id LIMIT 50", &[json!(cutoff)])?;
            Ok(json!({"run_ids":rows.iter().map(|r|r["id"].clone()).collect::<Vec<_>>()}))
        }
        "archive_prepare" => prepare(db, &string(&c, "run_id")?, now),
        "archive_commit" => commit(db, &c, now),
        "archive_status" => status(db, &string(&c, "run_id")?),
        "schedule_archive_due" => schedule_due(db, now),
        _ => Err(Error::new("NOT_FOUND", "Unknown archive operation")),
    }
}

fn ensure_quiescent<S: SqlStore>(db: &S, run_id: &str) -> Result<()> {
    if run_jobs(db, run_id)?
        .iter()
        .any(|j| j["status"] == "queued" || j["status"] == "running")
    {
        return Err(Error::new(
            "ARCHIVE_ACTIVE_WORK",
            "Run has queued or running jobs",
        ));
    }
    let live = db.query("SELECT id FROM jobs WHERE json_extract(payload,'$.external')=1 AND json_extract(payload,'$.status') IN ('queued','running') AND (json_extract(payload,'$.payload.execution.run_id')=? OR json_extract(payload,'$.payload.run_id')=? OR json_extract(payload,'$.payload.candidate.run_id')=?) LIMIT 1", &[json!(run_id),json!(run_id),json!(run_id)])?;
    if !live.is_empty() {
        return Err(Error::new(
            "ARCHIVE_ACTIVE_WORK",
            "Run has a live external attempt",
        ));
    }
    let external = db.query("SELECT id FROM executions WHERE json_extract(payload,'$.run_id')=? AND json_extract(payload,'$.harness')='external' AND json_extract(payload,'$.status')='running' LIMIT 1", &[json!(run_id)])?;
    if !external.is_empty() {
        return Err(Error::new(
            "ARCHIVE_ACTIVE_WORK",
            "Run has a live external execution",
        ));
    }
    Ok(())
}

fn archive_bundle<S: SqlStore>(db: &S, run_id: &str) -> Result<Value> {
    let mut bundle = run_detail(db, run_id)?;
    let high = checked_watermark(
        db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events", &[])?[0]["seq"]
            .as_i64()
            .unwrap_or_default(),
    )?;
    let mut nodes = Vec::<Value>::new();
    let mut edges = Vec::<Value>::new();
    let mut cursor = None;
    loop {
        let page = run_graph_page(db, run_id, cursor.as_deref(), 200, Some(high))?;
        nodes.extend(page["nodes"].as_array().into_iter().flatten().cloned());
        edges.extend(page["edges"].as_array().into_iter().flatten().cloned());
        cursor = page["next_cursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    nodes.sort_by_key(|v| v["id"].as_str().unwrap_or_default().to_owned());
    nodes.dedup_by(|a, b| a["id"] == b["id"]);
    bundle["nodes"] = json!(nodes);
    bundle["edges"] = json!(edges);
    bundle["graph_paged"] = json!(false);
    if let Some(record) = bundle.as_object_mut() {
        for key in ["repository", "archive", "capabilities", "seq", "watermark"] {
            record.remove(key);
        }
    }
    let execution_ids = bundle["executions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v["id"].as_str())
        .collect::<Vec<_>>();
    let mut logs = Vec::new();
    for execution_id in execution_ids {
        for row in db.query("SELECT seq,event_id,execution_id,at,data FROM execution_logs WHERE execution_id=? ORDER BY seq", &[json!(execution_id)])? {
            logs.push(json!({"seq":row["seq"],"event_id":row["event_id"],"execution_id":row["execution_id"],"at":row["at"],"data":serde_json::from_str::<Value>(row["data"].as_str().ok_or_else(||bad("Corrupt execution log"))?).map_err(|e|bad(&e.to_string()))?}));
        }
    }
    logs.sort_by_key(|v| v["seq"].as_i64().unwrap_or_default());
    bundle["execution_logs"] = json!(logs);
    Ok(bundle)
}

fn prepare<S: SqlStore>(db: &S, run_id: &str, now: i64) -> Result<Value> {
    ensure_quiescent(db, run_id)?;
    let id = format!("archive:{run_id}");
    if let Ok(job) = get(db, "archive_jobs", &id) {
        if job["status"] == "committed" {
            return Ok(json!({"job":job,"archived":true}));
        }
        let bundle_json = job["bundle_json"]
            .as_str()
            .ok_or_else(|| bad("Prepared archive is missing its immutable bundle"))?;
        verify_bundle(bundle_json, &job["digest"])?;
        return prepared_response(&job, bundle_json);
    }
    let run = get(db, "runs", run_id)?;
    let created = run["created_at"].as_i64().unwrap_or(i64::MAX);
    if !matches!(
        run["status"].as_str(),
        Some("accepted" | "cancelled" | "failed" | "ready")
    ) || created > now.saturating_sub(30 * DAY_MS)
    {
        return Err(Error::new(
            "ARCHIVE_NOT_ELIGIBLE",
            "Only terminal runs older than 30 days can be archived",
        ));
    }
    let bundle = archive_bundle(db, run_id)?;
    let bundle_json = serde_json::to_string(&bundle).map_err(|e| bad(&e.to_string()))?;
    let digest = digest(&bundle_json);
    let repository_id = string(&repo(db)?, "id")?;
    let object_key = format!("history/{repository_id}/{run_id}.json");
    let job = json!({"id":id,"run_id":run_id,"status":"prepared","digest":digest,"object_key":object_key,"created_at":now,"bundle_json":bundle_json});
    create(db, "archive_jobs", &id, &job)?;
    prepared_response(&job, &bundle_json)
}

fn prepared_response(job: &Value, bundle_json: &str) -> Result<Value> {
    let mut public_job = job.clone();
    if let Some(object) = public_job.as_object_mut() {
        object.remove("bundle_json");
    }
    Ok(json!({"job":public_job,"bundle_json":bundle_json}))
}

fn verify_bundle(bundle_json: &str, expected: &Value) -> Result<()> {
    if digest(bundle_json) != expected.as_str().unwrap_or_default() {
        return Err(Error::new(
            "ARCHIVE_DIGEST_MISMATCH",
            "Prepared history changed before archive acknowledgment",
        ));
    }
    Ok(())
}

fn digest(bundle_json: &str) -> String {
    yoneda_core::digest(bundle_json.as_bytes())
}

fn compact_object(value: &mut Value, keep: &[&str]) {
    if let Some(object) = value.as_object_mut() {
        object.retain(|key, _| keep.contains(&key.as_str()));
    }
}

fn compact_job(mut job: Value) -> Value {
    let payload = &mut job["payload"];
    if payload["execution"].is_object() {
        compact_object(
            &mut payload["execution"],
            &["id", "run_id", "parent_execution", "parent_epoch"],
        );
    }
    if payload["candidate"].is_object() {
        compact_object(&mut payload["candidate"], &["id", "run_id", "execution"]);
    }
    compact_object(
        payload,
        &["execution", "candidate", "run_id", "decision_id"],
    );
    job
}

fn compact<S: SqlStore>(db: &S, run_id: &str, bundle: &Value) -> Result<usize> {
    let jobs = run_jobs(db, run_id)?;
    for job in &jobs {
        if job["status"] == "queued" || job["status"] == "running" {
            return Err(Error::new(
                "ARCHIVE_ACTIVE_WORK",
                "Run acquired active work before archive commit",
            ));
        }
        let id = string(job, "id")?;
        save(db, "jobs", &id, &compact_job(job.clone()))?;
    }
    let archived_log_sequences = bundle["execution_logs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|log| log["seq"].as_i64())
        .collect::<std::collections::BTreeSet<_>>();
    let mut pruned = 0;
    for seq in archived_log_sequences {
        let rows = db.query("UPDATE execution_logs SET data='{}',data_pruned=1 WHERE seq=? AND data_pruned=0 RETURNING seq", &[json!(seq)])?;
        pruned += rows.len();
    }
    Ok(pruned)
}

fn commit<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let id = string(c, "job_id")?;
    let mut job = get(db, "archive_jobs", &id)?;
    let supplied = hash(c, "digest", &[64])?;
    if supplied != job["digest"]
        || c.get("verified_digest").and_then(Value::as_str) != Some(supplied.as_str())
    {
        return Err(Error::new(
            "ARCHIVE_DIGEST_MISMATCH",
            "Archive object digest was not verified against prepared history",
        ));
    }
    if job["status"] == "committed" {
        return Ok(job["receipt"].clone());
    }
    let bundle_json = job["bundle_json"]
        .as_str()
        .ok_or_else(|| bad("Prepared archive is missing its immutable bundle"))?;
    if digest(bundle_json) != supplied {
        return Err(Error::new(
            "ARCHIVE_DIGEST_MISMATCH",
            "Prepared archive bytes no longer match their ledger digest",
        ));
    }
    let run_id = string(&job, "run_id")?;
    ensure_quiescent(db, &run_id)?;
    let bundle: Value = serde_json::from_str(bundle_json).map_err(|e| bad(&e.to_string()))?;
    let receipt_id = string(c, "receipt_id")?;
    let receipt = json!({"id":receipt_id,"run_id":run_id,"digest":supplied,"object_key":job["object_key"],"committed_at":now});
    let index =
        json!({"run_id":run_id,"digest":supplied,"object_key":job["object_key"],"receipt":receipt});
    db.query(
        "INSERT INTO archive_index(run_id,payload) VALUES(?,?)",
        &[json!(run_id), json!(index.to_string())],
    )?;
    let pruned_logs = compact(db, &run_id, &bundle)?;
    job["status"] = json!("committed");
    job["receipt"] = receipt.clone();
    job["committed_at"] = json!(now);
    job["compacted_logs"] = json!(pruned_logs);
    job.as_object_mut()
        .map(|object| object.remove("bundle_json"));
    save(db, "archive_jobs", &id, &job)?;
    event(db, "history.archived", now, receipt.clone())?;
    Ok(receipt)
}

fn status<S: SqlStore>(db: &S, run_id: &str) -> Result<Value> {
    let rows = db.query(
        "SELECT payload FROM archive_index WHERE run_id=?",
        &[json!(run_id)],
    )?;
    match rows.first() {
        Some(r) => serde_json::from_str(
            r["payload"]
                .as_str()
                .ok_or_else(|| bad("Corrupt archive index"))?,
        )
        .map_err(|e| bad(&e.to_string())),
        None => Err(Error::new("NOT_FOUND", "No archived history for this run")),
    }
}

fn schedule_due<S: SqlStore>(db: &S, now: i64) -> Result<Value> {
    let day = now.div_euclid(DAY_MS);
    let checkpoint = db.query(
        "SELECT payload FROM maintenance_checkpoints WHERE id='archive_due'",
        &[],
    )?;
    if let Some(row) = checkpoint.first() {
        let value: Value = serde_json::from_str(
            row["payload"]
                .as_str()
                .ok_or_else(|| bad("Corrupt maintenance checkpoint"))?,
        )
        .map_err(|e| bad(&e.to_string()))?;
        if value["day"].as_i64().unwrap_or(i64::MIN) >= day {
            return Ok(json!({"scheduled":false,"day":day,"checkpoint":value}));
        }
    }
    let id = format!("archive-due:{day}");
    outbox(
        db,
        &id,
        "archive_due",
        json!({"day":day,"scheduled_at":now}),
    )?;
    let checkpoint = json!({"day":day,"scheduled_at":now,"outbox_id":id});
    db.query("INSERT INTO maintenance_checkpoints(id,payload) VALUES('archive_due',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", &[json!(checkpoint.to_string())])?;
    event(db, "history.archive_due_scheduled", now, checkpoint.clone())?;
    Ok(json!({"scheduled":true,"day":day,"checkpoint":checkpoint}))
}
