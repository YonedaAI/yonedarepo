use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
mod active_runs;
mod history;
mod jobs;
mod lineage;
mod migrations;
pub(crate) use active_runs::{active_run_count, external_run_count};
pub(crate) use history::{
    checked_watermark, prune_outbox_payloads, repository_overview, run_detail, run_graph_page,
    run_page,
};
pub(crate) use jobs::{job, job_event};
pub(crate) use lineage::{
    cancel_job, check_lineage, descendant_ids, fence_descendants, run_executions, run_jobs,
};
pub use migrations::migrate;

pub use yoneda_store::SqlStore;
pub(crate) use yoneda_store::{bad, number, string};

pub(crate) fn hash(v: &Value, key: &str, lengths: &[usize]) -> Result<String> {
    let s = string(v, key)?;
    if !lengths.contains(&s.len()) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad(&format!("Invalid {key} digest")));
    }
    Ok(s)
}
pub(crate) fn get<S: SqlStore>(db: &S, table: &str, id: &str) -> Result<Value> {
    let rows = db.query(
        &format!("SELECT payload FROM {table} WHERE id=?"),
        &[json!(id)],
    )?;
    let row = rows
        .first()
        .ok_or_else(|| Error::new("NOT_FOUND", format!("Unknown {table} {id}")))?;
    serde_json::from_str(
        row["payload"]
            .as_str()
            .ok_or_else(|| bad("Corrupt payload"))?,
    )
    .map_err(|e| Error::new("DATABASE", e.to_string()))
}
pub(crate) fn all<S: SqlStore>(db: &S, table: &str) -> Result<Vec<Value>> {
    db.query(&format!("SELECT payload FROM {table} ORDER BY id"), &[])?
        .iter()
        .map(|r| {
            serde_json::from_str(
                r["payload"]
                    .as_str()
                    .ok_or_else(|| bad("Corrupt payload"))?,
            )
            .map_err(|e| Error::new("DATABASE", e.to_string()))
        })
        .collect()
}
pub(crate) fn save<S: SqlStore>(db: &S, table: &str, id: &str, value: &Value) -> Result<()> {
    db.query(&format!("INSERT INTO {table}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload"),&[json!(id),json!(value.to_string())])?;
    if table == "team_tasks" {
        db.query("UPDATE nodes SET payload=json_set(payload,'$.data',json(?)) WHERE id=? AND json_extract(payload,'$.kind')='team_task'", &[json!(value.to_string()),json!(format!("team-task:{id}"))])?;
    }
    let kind = match table {
        "runs" => Some("run"),
        "executions" => Some("execution"),
        "candidates" => Some("candidate"),

        _ => None,
    };
    if let Some(kind) = kind {
        db.query("UPDATE nodes SET payload=json_set(payload,'$.data',json(?)) WHERE id=? AND json_extract(payload,'$.kind')=?", &[json!(value.to_string()),json!(id),json!(kind)])?;
    }
    Ok(())
}
pub(crate) fn create<S: SqlStore>(db: &S, table: &str, id: &str, value: &Value) -> Result<()> {
    if get(db, table, id).is_ok() {
        return Err(Error::new(
            "ALREADY_EXISTS",
            format!("{table} {id} already exists"),
        ));
    }
    save(db, table, id, value)
}
pub(crate) fn repo<S: SqlStore>(db: &S) -> Result<Value> {
    get(db, "repository", "repo")
}
pub(crate) fn node<S: SqlStore>(
    db: &S,
    id: &str,
    kind: &str,
    label: &str,
    author: &str,
    now: i64,
    data: Value,
) -> Result<()> {
    save(
        db,
        "nodes",
        id,
        &json!({"id":id,"kind":kind,"label":label,"author":author,"recorded_at":now,"data":data}),
    )
}
/// Update the execution and its graph projection in the caller's transaction.
pub(crate) fn save_execution<S: SqlStore>(db: &S, execution: &Value, _now: i64) -> Result<()> {
    let id = string(execution, "id")?;
    save(db, "executions", &id, execution)
}
pub(crate) fn edge<S: SqlStore>(
    db: &S,
    source: &str,
    target: &str,
    relation: &str,
    evidence: &str,
) -> Result<()> {
    db.query(
        "INSERT OR IGNORE INTO edges(source,target,relation,evidence) VALUES(?,?,?,?)",
        &[
            json!(source),
            json!(target),
            json!(relation),
            json!(evidence),
        ],
    )?;
    db.query("INSERT OR IGNORE INTO edge_history(source,target,relation,seq) SELECT ?,?,?,COALESCE(MAX(seq),0)+1 FROM events", &[json!(source),json!(target),json!(relation)])?;
    Ok(())
}
pub(crate) fn outbox<S: SqlStore>(db: &S, id: &str, kind: &str, payload: Value) -> Result<()> {
    db.query(
        "INSERT OR IGNORE INTO outbox(id,kind,payload,created_at) VALUES(?,?,?,COALESCE(json_extract(?,'$.event.at'),(SELECT MAX(at) FROM events),0))",
        &[json!(id), json!(kind), json!(payload.to_string()),json!(payload.to_string())],
    )?;
    Ok(())
}
pub(crate) fn event<S: SqlStore>(db: &S, kind: &str, now: i64, data: Value) -> Result<()> {
    let rows = db.query(
        "INSERT INTO events(kind,at,data) VALUES(?,?,?) RETURNING seq",
        &[json!(kind), json!(now), json!(data.to_string())],
    )?;
    let seq = rows[0]["seq"]
        .as_i64()
        .ok_or_else(|| bad("Event sequence missing"))?;
    if kind == "run.created" {
        if let Some(run_id) = data["id"].as_str() {
            db.query(
                "INSERT OR IGNORE INTO run_history(run_id,seq,created_at) SELECT id,?,CAST(json_extract(payload,'$.created_at') AS INTEGER) FROM runs WHERE id=?",
                &[json!(seq),json!(run_id)],
            )?;
        }
    } else if kind == "contribution.started"
        && let Some(execution_id) = data["execution"].as_str()
    {
        db.query(
            "INSERT OR IGNORE INTO run_history(run_id,seq,created_at) SELECT r.id,?,CAST(json_extract(r.payload,'$.created_at') AS INTEGER) FROM runs r JOIN executions e ON json_extract(e.payload,'$.run_id')=r.id WHERE e.id=?",
            &[json!(seq),json!(execution_id)],
        )?;
    }
    let r = repo(db)?;
    let payload = json!({"repo_id":r["id"],"seq":seq,"event":{"seq":seq,"kind":kind,"at":now,"data":data},"repository":r});
    outbox(db, &format!("live:{seq}"), "live", payload.clone())?;
    outbox(db, &format!("index:{seq}"), "index", payload)?;
    Ok(())
}
pub(crate) fn active<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let id = string(c, "job_id")?;
    let j = get(db, "jobs", &id)?;
    if c.get("_grant").is_some()
        && (j["external_grant"] != c["_grant"] || j["external_phase"] != "working")
    {
        return Err(Error::new(
            "FENCED",
            "External attempt identity or write phase changed",
        ));
    }
    if j["status"] != "running"
        || number(&j, "epoch")? != number(c, "epoch")?
        || number(&j, "lease_until")? <= now
        || number(&j, "attempt_deadline")? <= now
    {
        return Err(Error::new(
            "FENCED",
            "Attempt expired, was cancelled, or has been superseded",
        ));
    }
    check_lineage(db, &j, now)?;
    Ok(j)
}
