//! Owner rejection and recovery of a falsely conflicted publication. Neither moves canonical Git.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

const MAX_REASON: usize = 2000;
const MAX_REQUEST_ID: usize = 128;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    match string(c, "op")?.as_str() {
        "reject_candidate" => reject(db, c, now),
        "recover_publication" => recover(db, c, now),
        _ => Err(Error::new("NOT_FOUND", "Unknown publication operation")),
    }
}

/// The canonical head a publisher may replace, recorded before selection reserves a target.
pub(super) fn canonical_lease(r: &Value) -> Result<Value> {
    Ok(json!({
        "repository": format!("{}/{}", string(&r["remote"], "namespace")?, string(&r["remote"], "name")?),
        "commit": r["head_commit"],
    }))
}

/// A recorded owner rejection permanently removes a candidate from selection.
pub(super) fn not_rejected(candidate: &Value) -> Result<()> {
    if candidate
        .get("owner_rejection")
        .is_some_and(|v| !v.is_null())
    {
        return Err(Error::new(
            "CANDIDATE_REJECTED",
            "This result was rejected by its owner; refresh to see the recorded decision",
        ));
    }
    Ok(())
}

fn request_id(c: &Value) -> Result<String> {
    let id = string(c, "request_id")?;
    if id.trim().is_empty() || id.len() > MAX_REQUEST_ID {
        return Err(bad("Invalid request_id"));
    }
    Ok(id)
}

fn reject<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if c.get("job_id").is_some() || c.get("_grant").is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the owner or reviewer may reject a result",
        ));
    }
    let request = request_id(c)?;
    let reason = string(c, "reason")?.trim().to_owned();
    if reason.is_empty() || reason.chars().count() > MAX_REASON {
        return Err(bad(
            "A rejection reason of at most 2000 characters is required",
        ));
    }
    let cid = string(c, "candidate")?;
    let input = json!({"request_id":request,"candidate":cid,"expected_commit":c["expected_commit"],
        "expected_version":c["expected_version"],"reason":reason});
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
    let r = repo(db)?;
    if c["expected_commit"] != r["head_commit"] || c["expected_version"] != r["version"] {
        return Err(Error::new(
            "HEAD_MOVED",
            "Canonical revision or version changed",
        ));
    }
    let mut candidate = get(db, "candidates", &cid)?;
    not_rejected(&candidate)?;
    if !db
        .query(
            "SELECT id FROM decisions WHERE json_extract(payload,'$.candidate')=? AND json_extract(payload,'$.status')<>'rejected' LIMIT 1",
            &[json!(cid)],
        )?
        .is_empty()
    {
        return Err(Error::new(
            "INVALID_STATE",
            "This result was already selected for publication",
        ));
    }
    let did = format!("decision:{request}");
    let receipt = json!({"id":did,"status":"rejected","candidate":cid,"commit":candidate["revision"]["commit"]});
    let decision = json!({"id":did,"request_id":request,"fingerprint":fingerprint,"receipt":receipt,
        "status":"rejected","candidate":cid,"run_id":candidate["run_id"],"base":candidate["base"],
        "target":candidate["revision"],"reason":reason,"rationale":reason,"decision_kind":"human",
        "alternatives":[],"created_at":now});
    create(db, "decisions", &did, &decision)?;
    candidate["owner_rejection"] = json!({"decision_id":did,"reason":reason,"rejected_at":now});
    save(db, "candidates", &cid, &candidate)?;
    node(db, &did, "decision", &reason, "owner", now, decision)?;
    edge(db, &cid, &did, "rejected_by", "human decision")?;
    event(db, "decision.rejected", now, receipt.clone())?;
    Ok(receipt)
}

/// Republish a selection whose publisher reported a conflict although the canonical remote
/// still holds the head recorded at decision time. A genuinely moved remote is refused.
fn recover<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let mut r = repo(db)?;
    let workspace = string(c, "_workspace")?;
    if c.get("_grant").is_some()
        || c.get("job_id").is_some()
        || r["workspace"].as_str().unwrap_or("_admin") != workspace
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the repository owner can recover a publication",
        ));
    }
    let request = request_id(c)?;
    let did = string(c, "decision_id")?;
    let expected = number(c, "expected_version")?;
    let observed = hash(c, "observed_commit", &[40, 64])?;
    // The trusted adapter's fresh observation is checked below, not fingerprinted, so a replay
    // after acknowledgement loss still returns its receipt once the remote has advanced.
    let fingerprint =
        yoneda_core::fingerprint(&json!({"decision_id":did,"expected_version":expected}))?;
    let key = yoneda_core::digest(request.as_bytes());
    if let Some(prior) = r["publication_recoveries"].get(&key) {
        if prior["fingerprint"] != fingerprint {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Request ID was used with different input",
            ));
        }
        return Ok(prior["receipt"].clone());
    }
    if r["version"] != expected {
        return Err(Error::new(
            "HEAD_MOVED",
            "Repository version changed; refresh before retrying publication",
        ));
    }
    let mut d = get(db, "decisions", &did)?;
    if d["status"] != "publication_conflict" || r["pending"] != did || r["status"] != "blocked" {
        return Err(Error::new(
            "INVALID_STATE",
            "Only a blocked publication conflict can be retried",
        ));
    }
    // Before recovery existed the decision did not record this; canonical publication stays
    // unchanged while a decision is pending, so the repository still holds it.
    let recorded = d
        .get("published_before")
        .unwrap_or(&r["published_commit"])
        .clone();
    let reported = d["observed"]["observed"].as_str();
    if recorded != observed || reported.is_some_and(|commit| commit != observed) {
        return Err(Error::new(
            "REMOTE_CHANGED",
            "The canonical remote changed since this decision; resynchronize instead",
        ));
    }
    let cid = string(&d, "candidate")?;
    let candidate = get(db, "candidates", &cid)?;
    if candidate["revision"] != d["target"] || r["head_commit"] != d["target"]["commit"] {
        return Err(Error::new("FENCED", "The selected target changed"));
    }
    super::acceptance::current_checks(db, &candidate, &cid, &r, d["checks_overridden"] == true)?;
    if get(db, "runs", &string(&candidate, "run_id")?)?["status"] == "cancelled" {
        return Err(Error::new("FENCED", "Run was cancelled"));
    }
    super::recovery::fence_publication(db, &json!(did))?;
    let previous_job = d["publisher_job"]
        .as_str()
        .map_or_else(|| format!("publish:{did}"), str::to_owned);
    let previous_expected = d.get("publication_expected").unwrap_or(&d["base"]).clone();
    let mut history = d["publication_history"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    history.push(
        json!({"status":d["status"],"observed":d["observed"],"expected":previous_expected,
        "job":previous_job,"recovered_at":now,"request_id":request,"observed_commit":observed}),
    );
    let job_id = format!("publish:{did}:recovery:{}", history.len());
    let mut lease = canonical_lease(&r)?;
    lease["commit"] = json!(observed);
    d["publication_history"] = json!(history);
    d["status"] = json!("publication_pending");
    d["publication_expected"] = lease.clone();
    d["published_before"] = json!(observed);
    d["publisher_job"] = json!(job_id);
    if let Some(object) = d.as_object_mut() {
        object.remove("observed");
    }
    save(db, "decisions", &did, &d)?;
    let author = if d["decision_kind"] == "development_verification" {
        "owner_automation"
    } else {
        "owner"
    };
    node(
        db,
        &did,
        "decision",
        d["rationale"].as_str().unwrap_or("Decision"),
        author,
        now,
        d.clone(),
    )?;
    let version = expected
        .checked_add(1)
        .ok_or_else(|| bad("Version overflow"))?;
    let receipt = json!({"id":did,"status":"publication_pending","version":version,
        "commit":d["target"]["commit"],"job_id":job_id});
    r["status"] = json!("ready");
    r["version"] = json!(version);
    r["publication_recoveries"][&key] = json!({"fingerprint":fingerprint,"receipt":receipt});
    save(db, "repository", "repo", &r)?;
    job(
        db,
        &job_id,
        "publish",
        now,
        json!({"decision_id":did,"expected":lease,"target":d["target"],"canonical":r["remote"],
            "execution":{"id":candidate["execution"],"run_id":candidate["run_id"]}}),
    )?;
    event(db, "decision.publication_recovered", now, receipt.clone())?;
    Ok(receipt)
}
