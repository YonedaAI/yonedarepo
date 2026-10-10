use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "archive_candidates" => {
            let cutoff = now.saturating_sub(30 * 24 * 60 * 60 * 1000);
            let rows=db.query("SELECT r.id FROM runs r LEFT JOIN archive_index a ON a.run_id=r.id WHERE a.run_id IS NULL AND json_extract(r.payload,'$.status') IN ('accepted','cancelled','failed','ready') AND CAST(json_extract(r.payload,'$.created_at') AS INTEGER)<=? ORDER BY json_extract(r.payload,'$.created_at'),r.id LIMIT 50", &[json!(cutoff)])?;
            Ok(json!({"run_ids":rows.iter().map(|r|r["id"].clone()).collect::<Vec<_>>()}))
        }
        "archive_prepare" => prepare(db, &string(&c, "run_id")?, now),
        "archive_commit" => commit(db, &c, now),
        "archive_status" => status(db, &string(&c, "run_id")?),
        _ => Err(Error::new("NOT_FOUND", "Unknown archive operation")),
    }
}
fn prepare<S: SqlStore>(db: &S, run_id: &str, now: i64) -> Result<Value> {
    let id = format!("archive:{run_id}");
    if let Ok(job) = get(db, "archive_jobs", &id) {
        let bundle = run_detail(db, run_id)?;
        let digest =
            yoneda_core::digest(&serde_json::to_vec(&bundle).map_err(|e| bad(&e.to_string()))?);
        if digest != job["digest"] {
            return Err(Error::new(
                "ARCHIVE_DIGEST_MISMATCH",
                "Prepared history changed before archive acknowledgment",
            ));
        }
        return Ok(json!({"job":job,"bundle":bundle}));
    }
    let run = get(db, "runs", run_id)?;
    let created = run["created_at"].as_i64().unwrap_or(i64::MAX);
    if !matches!(
        run["status"].as_str(),
        Some("accepted" | "cancelled" | "failed" | "ready")
    ) || created > now.saturating_sub(30 * 24 * 60 * 60 * 1000)
    {
        return Err(Error::new(
            "ARCHIVE_NOT_ELIGIBLE",
            "Only terminal runs older than 30 days can be archived",
        ));
    }
    let bundle = run_detail(db, run_id)?;
    let bytes = serde_json::to_vec(&bundle).map_err(|e| bad(&e.to_string()))?;
    let digest = yoneda_core::digest(&bytes);
    let job = json!({"id":id,"run_id":run_id,"status":"prepared","digest":digest,"object_key":format!("history/{}/{}.json",repo(db)?["id"],run_id),"created_at":now});
    create(db, "archive_jobs", &id, &job)?;
    Ok(json!({"job":job,"bundle":bundle}))
}
fn commit<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let id = string(c, "job_id")?;
    let mut job = get(db, "archive_jobs", &id)?;
    let supplied = hash(c, "digest", &[64])?;
    if supplied != job["digest"] {
        return Err(Error::new(
            "ARCHIVE_DIGEST_MISMATCH",
            "Archive object digest does not match prepared history",
        ));
    }
    if job["status"] == "committed" {
        return Ok(job["receipt"].clone());
    }
    let receipt_id = string(c, "receipt_id")?;
    let receipt = json!({"id":receipt_id,"run_id":job["run_id"],"digest":supplied,"object_key":job["object_key"],"committed_at":now});
    let index = json!({"run_id":job["run_id"],"digest":supplied,"object_key":job["object_key"],"receipt":receipt});
    db.query(
        "INSERT INTO archive_index(run_id,payload) VALUES(?,?)",
        &[job["run_id"].clone(), json!(index.to_string())],
    )?;
    job["status"] = json!("committed");
    job["receipt"] = receipt.clone();
    job["committed_at"] = json!(now);
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
