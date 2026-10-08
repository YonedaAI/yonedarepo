use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "accept" => accept(db, &c, now),
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
}
fn accept<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let kind = c["decision_kind"].as_str().unwrap_or("human");
    let (authorship, comparison, selection) = match kind {
        "human" => ("owner", "human comparison", "human decision"),
        "development_verification" => (
            "owner_automation",
            "automated development comparison",
            "automated development verification",
        ),
        _ => return Err(bad("Unsupported decision kind")),
    };
    let request = string(c, "request_id")?;
    let mut input = c.clone();
    input
        .as_object_mut()
        .ok_or_else(|| bad("Invalid request"))?
        .remove("now");
    let fingerprint = yoneda_core::fingerprint(&input)?;
    for d in all(db, "decisions")? {
        if d["request_id"] == request {
            if d["fingerprint"] != fingerprint {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Request ID was used with different input",
                ));
            }
            return Ok(d["receipt"].clone());
        }
    }
    let mut r = repo(db)?;
    if !r["pending"].is_null() {
        return Err(Error::new(
            "PUBLICATION_PENDING",
            "Another decision is awaiting publication",
        ));
    }
    if r["status"] != "ready" {
        return Err(Error::new(
            "REPOSITORY_BLOCKED",
            "Canonical remote requires explicit resynchronization",
        ));
    }
    if c["expected_commit"] != r["head_commit"] || c["expected_version"] != r["version"] {
        return Err(Error::new(
            "HEAD_MOVED",
            "Canonical revision or version changed",
        ));
    }
    let cid = string(c, "candidate")?;
    let candidate = get(db, "candidates", &cid)?;
    if candidate["base"]["commit"] != r["head_commit"] {
        return Err(Error::new(
            "HEAD_MOVED",
            "Candidate was created against an older base",
        ));
    }
    let run = get(db, "runs", &string(&candidate, "run_id")?)?;
    if run["status"] == "cancelled" {
        return Err(Error::new("FENCED", "Run was cancelled"));
    }
    let eid = string(&candidate, "evaluation").map_err(|_| {
        Error::new(
            "MISSING_EVIDENCE",
            "Candidate has not been independently evaluated",
        )
    })?;
    let evaluation: yoneda_core::Evaluation =
        serde_json::from_value(get(db, "evaluations", &eid)?).map_err(|e| bad(&e.to_string()))?;
    let policy: yoneda_core::Policy =
        serde_json::from_value(r["policy"].clone()).map_err(|e| bad(&e.to_string()))?;
    let revision: yoneda_core::Revision =
        serde_json::from_value(candidate["revision"].clone()).map_err(|e| bad(&e.to_string()))?;
    yoneda_core::validate_evaluation(&evaluation, &cid, &revision, &policy)?;
    if policy
        .build
        .as_ref()
        .and_then(|b| b.static_dir.as_ref())
        .is_some()
    {
        let stored = get(db, "evaluations", &eid)?;
        if stored["deployment"]["commit"] != candidate["revision"]["commit"]
            || stored["deployment"]["digest"].as_str().is_none()
        {
            return Err(Error::new(
                "CHECKS_FAILED",
                "Static output must be recaptured before publication",
            ));
        }
    }

    if candidate["status"] != "eligible" {
        return Err(Error::new(
            "CHECKS_FAILED",
            "Candidate is not currently eligible",
        ));
    }

    let rationale = string(c, "rationale")?;
    let did = format!("decision:{request}");
    let receipt = json!({"id":did,"status":"publication_pending","version":number(&r,"version")?+1,"commit":revision.commit});
    let d = json!({"id":did,"request_id":request,"fingerprint":fingerprint,"receipt":receipt,"status":"publication_pending","candidate":cid,"run_id":candidate["run_id"],"base":candidate["base"],"target":candidate["revision"],"rationale":rationale,"decision_kind":kind,"alternatives":c.get("alternatives").cloned().unwrap_or(json!([])),"created_at":now});
    create(db, "decisions", &did, &d)?;
    r["head_commit"] = json!(revision.commit);
    r["version"] = receipt["version"].clone();
    r["pending"] = json!(did);
    save(db, "repository", "repo", &r)?;
    node(db, &did, "decision", &rationale, authorship, now, d.clone())?;
    for other in all(db, "candidates")?
        .iter()
        .filter(|v| v["run_id"] == candidate["run_id"])
    {
        edge(db, &string(other, "id")?, &did, "considered_by", comparison)?;
    }
    edge(db, &cid, &did, "selected_by", selection)?;
    for path in candidate["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let anchor = format!("source:{}:{path}", revision.commit);
        node(
            db,
            &anchor,
            "source",
            path,
            "platform_capture",
            now,
            json!({"commit":revision.commit,"path":path,"repository":r["remote"],"decision":did}),
        )?;
        edge(
            db,
            &did,
            &anchor,
            "selected_as",
            "verified source identity; canonical publication pending",
        )?;
    }
    let mut run = run;
    run["status"] = json!("accepted");
    let rid = string(&run, "id")?;
    save(db, "runs", &rid, &run)?;
    job(
        db,
        &format!("publish:{did}"),
        "publish",
        now,
        json!({"decision_id":did,"expected":candidate["base"],"target":candidate["revision"],"canonical":r["remote"]}),
    )?;
    event(db, "decision.selected", now, receipt.clone())?;
    Ok(receipt)
}
