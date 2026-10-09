//! External agents contribute assertions and files; they never select or publish canonical source.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let op = string(&c, "op")?;
    if op == "external_begin" {
        return begin(db, &c, now);
    }
    let id = string(&c, "attempt_id")?;
    let jid = format!("job:{id}");
    let mut j = get(db, "jobs", &jid)?;
    if j["external_grant"] != c["_grant"] || j["external"] != true {
        return Err(Error::new(
            "FORBIDDEN",
            "Contribution belongs to another agent grant",
        ));
    }
    if op == "external_status" {
        return Ok(j);
    }
    if op == "external_submit" && j["status"] == "done" {
        if j["result"]["workspace"] != c["workspace"] {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Submission already captured different files",
            ));
        }
        return Ok(j["result"].clone());
    }
    active(db, &json!({"job_id":jid,"epoch":j["epoch"]}), now)?;
    match op.as_str() {
        "external_check" => {
            if j["external_phase"] != "working" {
                return Err(Error::new("FENCED", "Contribution writes are closed"));
            }
            Ok(j)
        }
        "external_freeze" => {
            if j["external_phase"] == "frozen" {
                return Ok(j);
            }
            j["external_phase"] = json!("frozen");
            save(db, "jobs", &jid, &j)?;
            event(db, "contribution.frozen", now, json!({"execution":id}))?;
            Ok(j)
        }
        "external_bind" => {
            if j["external_phase"] != "frozen" || c["revision"]["repository"] != j["external_fork"]
            {
                return Err(Error::new(
                    "FENCED",
                    "Contribution must be frozen in its isolated fork",
                ));
            }
            hash(&c["revision"], "commit", &[40, 64])?;
            if !j["submitted_revision"].is_null() && j["submitted_revision"] != c["revision"] {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Submission revision is already bound",
                ));
            }
            j["submitted_revision"] = c["revision"].clone();
            save(db, "jobs", &jid, &j)?;
            let mut e = get(db, "executions", &id)?;
            e["contribution_revision"] = c["revision"].clone();
            save_execution(db, &e, now)?;
            Ok(j)
        }
        "external_submit" => {
            if j["external_phase"] != "frozen" || j["submitted_revision"].is_null() {
                return Err(Error::new("FENCED", "Bind the frozen submission first"));
            }
            let workspace = hash(&c, "workspace", &[64])?;
            super::completion::handle(
                db,
                json!({"op":"finish","job_id":jid,"epoch":j["epoch"],"result":{"workspace":workspace}}),
                now,
            )
        }
        _ => Err(bad("Unknown contribution command")),
    }
}
fn begin<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let id = string(c, "id")?;
    let jid = format!("job:{id}");
    let grant = string(c, "_grant")?;
    let fingerprint = yoneda_core::fingerprint(
        &json!({"id":id,"grant":grant,"intent":c["intent"],"criteria":c["criteria"],"context":c["context"],"fork":c["fork"]}),
    )?;
    if let Ok(existing) = get(db, "jobs", &jid) {
        if existing["external_grant"] != grant || existing["fingerprint"] != fingerprint {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Attempt ID belongs to another request",
            ));
        }
        super::context_sessions::bind(db, c, &existing, now)?;
        return Ok(existing);
    }
    let r = repo(db)?;
    if !r["pending"].is_null() || r["status"] != "ready" {
        return Err(Error::new(
            "PUBLICATION_PENDING",
            "Repository is not ready for a contribution",
        ));
    }
    if all(db, "runs")?.len() >= 100 {
        return Err(bad("Repository run limit reached"));
    }
    let intent = string(c, "intent")?;
    let context = c.get("context").cloned().unwrap_or(json!([]));
    let references = context
        .as_array()
        .ok_or_else(|| bad("Context must be an array"))?;
    if references.len() > 50 {
        return Err(bad("At most 50 context references"));
    }
    let mut records = Vec::new();
    for reference in references {
        records.push(get(
            db,
            "nodes",
            reference
                .as_str()
                .ok_or_else(|| bad("Invalid context reference"))?,
        )?);
    }
    let criteria = c.get("criteria").cloned().unwrap_or(json!([]));
    let items = criteria
        .as_array()
        .ok_or_else(|| bad("Criteria must be an array"))?;
    if items.len() > 32
        || items
            .iter()
            .any(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 2048))
    {
        return Err(bad("Criteria must be bounded statements"));
    }
    let rid = format!("run:{id}");
    let base = json!({"repository":format!("{}/{}",string(&r["remote"],"namespace")?,string(&r["remote"],"name")?),"commit":r["published_commit"]});
    let mut run = json!({"id":rid,"intent":intent,"criteria":criteria,"context":context,"context_records":records,"policy":r["policy"],"base":base,"base_version":r["version"],"status":"exploring","created_at":now,"external":true,"context_usage_version":1});
    super::study::apply(&mut run, super::study::freeze(db, &r)?);
    create(db, "runs", &rid, &run)?;
    node(
        db,
        &format!("intent:{rid}"),
        "intent",
        &intent,
        "agent_assertion",
        now,
        json!({"criteria":criteria,"grant":grant}),
    )?;
    node(db, &rid, "run", &intent, "platform", now, run.clone())?;
    edge(
        db,
        &format!("intent:{rid}"),
        &rid,
        "implements",
        "external agent request",
    )?;
    let execution = json!({"id":id,"run_id":rid,"harness":"external","strategy":"Local agent contribution","role":"coding","status":"running","context":[],"base":base,"epoch":1,"started_at":now,"grant":grant});
    create(db, "executions", &id, &execution)?;
    node(
        db,
        &id,
        "execution",
        "Local agent contribution",
        "platform",
        now,
        execution.clone(),
    )?;
    edge(db, &rid, &id, "depends_on", "external contribution")?;
    let job = json!({"id":jid,"kind":"agent","status":"running","external":true,"external_grant":grant,"external_fork":string(c,"fork")?,"external_phase":"working","fingerprint":fingerprint,"attempt":2,"epoch":1,"lease_until":now+3_600_000,"attempt_deadline":now+3_600_000,"deadline":now+3_600_000,"payload":{"execution":execution,"run":run,"policy":r["policy"]}});
    create(db, "jobs", &jid, &job)?;
    super::context_sessions::bind(db, c, &job, now)?;
    event(
        db,
        "contribution.started",
        now,
        json!({"execution":id,"grant":grant}),
    )?;
    Ok(job)
}
