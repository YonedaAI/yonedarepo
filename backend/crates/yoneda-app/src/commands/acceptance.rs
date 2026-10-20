use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
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
    let fingerprint = yoneda_agents_core::fingerprint(&input)?;
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
    super::publication::not_rejected(&candidate)?;
    super::guided::validate_publish(db, &candidate)?;
    let working_publishable = super::branches::publishable(db, &candidate, &r)?;
    if !working_publishable
        && (candidate
            .get("refresh_expected_version")
            .is_some_and(|version| version != &r["version"])
            || candidate
                .get("conflict_expected_version")
                .is_some_and(|version| version != &r["version"]))
    {
        return Err(Error::new(
            "HEAD_MOVED",
            "Refreshed candidate's reserved repository version changed",
        ));
    }
    if candidate["base"]["commit"] != r["head_commit"] && !working_publishable {
        return Err(Error::new(
            "HEAD_MOVED",
            "Candidate was created against an older base",
        ));
    }
    let run = get(db, "runs", &string(&candidate, "run_id")?)?;
    super::comparison::validate_publish(db, &run, &candidate)?;
    super::team::validate_candidate(db, &run, &candidate)?;
    if run["status"] == "cancelled" {
        return Err(Error::new("FENCED", "Run was cancelled"));
    }
    check_lineage(
        db,
        &json!({"payload":{"execution":{"id":candidate["execution"]}}}),
        now,
    )?;
    let override_checks = c["accept_failed_checks"] == true;
    let revision = current_checks(db, &candidate, &cid, &r, override_checks)?;

    let rationale = string(c, "rationale")?;
    let did = format!("decision:{request}");
    // A checked working head's base may be an intermediate commit; the publisher leases the
    // canonical head observed before this selection reserves the target.
    let lease = super::publication::canonical_lease(&r)?;
    let receipt = json!({"id":did,"status":"publication_pending","version":number(&r,"version")?+1,"commit":revision.commit});
    let mut d = json!({"id":did,"request_id":request,"fingerprint":fingerprint,"receipt":receipt,"status":"publication_pending","candidate":cid,"run_id":candidate["run_id"],"base":candidate["base"],"target":candidate["revision"],"rationale":rationale,"decision_kind":kind,"alternatives":c.get("alternatives").cloned().unwrap_or(json!([])),"created_at":now,"publication_expected":lease,"published_before":r["published_commit"],"checks_overridden":override_checks});
    super::comparison::decision_provenance(db, &run, &mut d)?;
    create(db, "decisions", &did, &d)?;
    super::history::link_file_provenance_to_decision(db, &d, now)?;
    r["head_commit"] = json!(revision.commit);
    r["version"] = receipt["version"].clone();
    r["pending"] = json!(did);
    save(db, "repository", "repo", &r)?;
    node(db, &did, "decision", &rationale, authorship, now, d.clone())?;
    super::comparison::link_decision(db, &d)?;
    for other in all(db, "candidates")?
        .iter()
        .filter(|v| v["run_id"] == candidate["run_id"])
    {
        edge(db, &string(other, "id")?, &did, "considered_by", comparison)?;
    }
    edge(db, &cid, &did, "selected_by", selection)?;
    for path in crate::path_lists::load(db, &candidate, "paths")? {
        let anchor = format!("source:{}:{path}", revision.commit);
        node(
            db,
            &anchor,
            "source",
            &path,
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
        json!({"decision_id":did,"expected":lease,"target":candidate["revision"],"canonical":r["remote"],"execution":{"id":candidate["execution"],"run_id":candidate["run_id"]}}),
    )?;
    event(db, "decision.selected", now, receipt.clone())?;
    Ok(receipt)
}

/// The candidate's independent evaluation must still satisfy the repository's current policy.
pub(super) fn current_checks<S: SqlStore>(
    db: &S,
    candidate: &Value,
    cid: &str,
    r: &Value,
    accept_failed_checks: bool,
) -> Result<yoneda_agents_core::Revision> {
    super::publication::not_rejected(candidate)?;
    let eid = string(candidate, "evaluation").map_err(|_| {
        Error::new(
            "MISSING_EVIDENCE",
            "Candidate has not been independently evaluated",
        )
    })?;
    let evaluation: yoneda_agents_core::Evaluation =
        serde_json::from_value(get(db, "evaluations", &eid)?).map_err(|e| bad(&e.to_string()))?;
    let policy: yoneda_agents_core::Policy =
        serde_json::from_value(r["policy"].clone()).map_err(|e| bad(&e.to_string()))?;
    let revision: yoneda_agents_core::Revision =
        serde_json::from_value(candidate["revision"].clone()).map_err(|e| bad(&e.to_string()))?;
    yoneda_agents_core::validate_evaluation_binding(&evaluation, cid, &revision, &policy)?;
    // Failed required checks block publication unless the owner explicitly overrides them.
    if !accept_failed_checks {
        yoneda_agents_core::validate_required_checks(&evaluation, &policy)?;
    }
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

    if candidate["status"] != "eligible"
        && !(accept_failed_checks && candidate["status"] == "rejected")
    {
        return Err(Error::new(
            "CHECKS_FAILED",
            "Candidate is not currently eligible",
        ));
    }

    Ok(revision)
}
