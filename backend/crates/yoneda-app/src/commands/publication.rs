//! Publication is the owner's own platform landing of the selected commit: the ledger reserves
//! the selection, the owner reviews and lands it with their platform session, and only the
//! platform's readback completes it. Rejection and recovery never move canonical source.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};

const MAX_REASON: usize = 2000;
const MAX_REQUEST_ID: usize = 128;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    match string(c, "op")?.as_str() {
        "reject_candidate" => reject(db, c, now),
        "publication_readback" => readback(db, c, now),
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

/// What the owner lands on the platform, with their own session: exactly `commit` onto `main`
/// while it is still `expected`; overridden checks need the human break-glass path instead.
pub(super) fn owner_landing(r: &Value, commit: &str, lease: &Value, overridden: bool) -> Value {
    json!({"platform_repo":r["platform_repo"],"ref":"main","commit":commit,
        "expected":lease["commit"],"break_glass":overridden})
}

/// Complete a pending publication from the platform's readback of `main` (supplied only by
/// the trusted adapter): landed, still pending, or moved elsewhere (a conflict).
fn readback<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let did = string(c, "decision_id")?;
    let observed = hash(c, "observed_commit", &[40, 64])?;
    let mut d = get(db, "decisions", &did)?;
    let mut r = repo(db)?;
    if d["status"] == "published" && d["target"]["commit"] == observed {
        return Ok(d);
    }
    if r["pending"] != did || d["status"] != "publication_pending" {
        return Err(Error::new("FENCED", "Publication reservation changed"));
    }
    if d["target"]["commit"] == observed {
        super::completion::record_publication(db, &mut r, &mut d, now)?;
        d["land_version"] = c["land_version"].clone();
    } else if d["publication_expected"]["commit"] == observed {
        return Ok(d);
    } else {
        r["status"] = json!("blocked");
        d["status"] = json!("publication_conflict");
        d["observed"] = json!({"conflict":true,"commit":observed});
    }
    save(db, "repository", "repo", &r)?;
    save(db, "decisions", &did, &d)?;
    node(
        db,
        &did,
        "decision",
        d["rationale"].as_str().unwrap_or("Decision"),
        if d["decision_kind"] == "development_verification" {
            "owner_automation"
        } else {
            "owner"
        },
        now,
        d.clone(),
    )?;
    event(
        db,
        "decision.publication_observed",
        now,
        json!({"id":did,"status":d["status"],"observed_commit":observed}),
    )?;
    Ok(d)
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
