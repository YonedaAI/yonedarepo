use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
mod agent;
mod source;
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "finish" => finish(db, &c, now),
        "verify_finish" => {
            let j = active(db, &c, now)?;
            if j["kind"] != "evaluate" {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Only evaluator attempts submit observations",
                ));
            }
            let policy = &j["payload"]["policy"];
            if c["report"]["environment"] != policy["environment"]
                || c["report"]["suite"] != policy["suite"]
            {
                return Err(Error::new(
                    "ENVIRONMENT_MISMATCH",
                    "Evaluator runtime or suite does not match the requested policy; wait for container rollout completion",
                ));
            }
            let candidate = &j["payload"]["candidate"];
            let mut checks = if policy["build"].is_null() {
                yoneda_core::retry::checks_for_suite(&string(policy, "suite")?, &c["report"])?
            } else {
                let typed =
                    serde_json::from_value(policy.clone()).map_err(|e| bad(&e.to_string()))?;
                yoneda_core::build::checks_from_report(&typed, &c["report"])?
            };
            if policy["build"]["static_dir"].is_string() {
                checks.push(yoneda_core::Check {
                    name: "static_assets".into(),
                    status: if j["site"].is_null() { "fail" } else { "pass" }.into(),
                    detail: "Evaluator captured bounded regular static files from this revision"
                        .into(),
                });
            }
            let evidence = hash(&c, "evidence", &[64])?;
            let result = json!({"id":format!("evaluation:{}:{}",string(&j,"id")?,number(&j,"epoch")?),"candidate":candidate["id"],"revision":candidate["revision"],"policy":policy["version"],"suite":policy["suite"],"environment":policy["environment"],"checks":checks,"evidence":evidence,"deployment":j["site"]});
            let mut result = result;
            if policy["build"]["app"].is_object() && c["report"]["app_bundle_digest"].is_string() {
                if c["report"]["app_revision"] != candidate["revision"]["commit"] {
                    return Err(Error::new(
                        "INVALID_CAPTURE",
                        "App report revision differs from candidate",
                    ));
                }
                result["app"] = json!({"bundle_digest":hash(&c["report"],"app_bundle_digest",&[64])?,"revision":c["report"]["app_revision"],"policy_digest":c["report"]["app_policy_digest"]});
            }
            finish(
                db,
                &json!({"job_id":c["job_id"],"epoch":c["epoch"],"result":result}),
                now,
            )
        }
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
}
fn finish<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let mut j = active(db, c, now)?;
    let id = string(&j, "id")?;
    let result = &c["result"];
    match j["kind"].as_str().unwrap_or_default() {
        "agent" => agent::complete(db, &j, result, now)?,
        "capture" => {
            if j["payload"]["capture_subtype"] == "resolve_conflict"
                || j["payload"]["source_resolution"] == true
            {
                super::conflicts::complete_resolver_capture(db, &j, result, now)?;
            } else {
                super::capture_completion::complete(db, &j, result, now)?;
            }
        }
        "evaluate" => {
            let candidate_id = string(&j["payload"]["candidate"], "id")?;
            let mut candidate = get(db, "candidates", &candidate_id)?;
            let rid = string(&candidate, "run_id")?;
            let mut run = get(db, "runs", &rid)?;
            let held = super::autonomy::hold_candidate(db, &run, &mut candidate)?;
            let evaluation: yoneda_core::Evaluation =
                serde_json::from_value(result.clone()).map_err(|e| bad(&e.to_string()))?;
            let policy: yoneda_core::Policy =
                serde_json::from_value(j["payload"]["policy"].clone())
                    .map_err(|e| bad(&e.to_string()))?;
            let revision: yoneda_core::Revision =
                serde_json::from_value(candidate["revision"].clone())
                    .map_err(|e| bad(&e.to_string()))?;
            let validation =
                yoneda_core::validate_evaluation(&evaluation, &candidate_id, &revision, &policy)
                    .and_then(|()| {
                        if policy
                            .build
                            .as_ref()
                            .and_then(|b| b.static_dir.as_ref())
                            .is_some()
                            && (result["deployment"]["commit"] != candidate["revision"]["commit"]
                                || result["deployment"]["digest"].as_str().is_none())
                        {
                            return Err(Error::new(
                                "CHECKS_FAILED",
                                "Static output was not independently captured",
                            ));
                        }
                        if policy.build.as_ref().is_some_and(|b| b.app.is_some())
                            && (result["app"]["revision"] != candidate["revision"]["commit"]
                                || result["app"]["bundle_digest"].as_str().is_none()
                                || result["app"]["policy_digest"]
                                    != yoneda_core::build::policy_digest(&policy)?)
                        {
                            return Err(Error::new(
                                "CHECKS_FAILED",
                                "App output was not independently captured for this revision",
                            ));
                        }
                        Ok(())
                    });
            if let Err(error) = &validation
                && error.code != "CHECKS_FAILED"
            {
                return Err(error.clone());
            }
            create(db, "evaluations", &evaluation.id, result)?;
            // A late historical evaluation remains evidence but cannot replace current eligibility.
            if j["payload"]["policy"] == repo(db)?["policy"] {
                candidate["status"] = json!(if held {
                    "awaiting_intent"
                } else if validation.is_ok() {
                    "eligible"
                } else {
                    "rejected"
                });
                candidate["evaluation"] = json!(evaluation.id);
                save(db, "candidates", &candidate_id, &candidate)?;
                node(
                    db,
                    &candidate_id,
                    "candidate",
                    candidate["summary"].as_str().unwrap_or("Candidate"),
                    "platform_capture",
                    now,
                    candidate.clone(),
                )?;
            }
            node(
                db,
                &evaluation.id,
                "evaluation",
                "Independent verification",
                "external_verifier",
                now,
                result.clone(),
            )?;
            edge(
                db,
                &evaluation.id,
                &candidate_id,
                "evaluates",
                &evaluation.evidence,
            )?;
            let eid = string(&candidate, "execution")?;
            let mut e = get(db, "executions", &eid)?;
            e["status"] = json!("completed");
            save_execution(db, &e, now)?;
            if !held && validation.is_ok() && j["payload"]["policy"] == repo(db)?["policy"] {
                super::branches::promote(db, &mut run, &mut candidate, now)?;
            }
            if run["status"] != "accepted" && !super::autonomy::intent_pending(&run) && !held {
                run["status"] = json!("ready");
            }
            save(db, "runs", &rid, &run)?;
            super::conflicts::resolver_evaluated(
                db,
                &candidate_id,
                validation.is_ok() && !held,
                now,
            )?;
            super::team::reflect(
                db,
                &e,
                if held {
                    "awaiting_intent"
                } else if validation.is_ok() {
                    "complete"
                } else {
                    "failed"
                },
                e["epoch"].clone(),
                now,
            )?;
            if !held {
                super::team::evaluated(db, &run, &candidate, validation.is_ok(), now)?;
            }
        }
        "publish" => {
            let did = string(&j["payload"], "decision_id")?;
            let mut d = get(db, "decisions", &did)?;
            let mut r = repo(db)?;
            if r["pending"] != did {
                return Err(Error::new("FENCED", "Publication reservation changed"));
            }
            if result["conflict"] == true || result["commit"] != d["target"]["commit"] {
                r["status"] = json!("blocked");
                d["status"] = json!("publication_conflict");
                d["observed"] = result.clone();
            } else {
                record_publication(db, &mut r, &mut d, now)?;
            }
            save(db, "repository", "repo", &r)?;
            save(db, "decisions", &did, &d)?;
            node(
                db,
                &did,
                "decision",
                d["rationale"].as_str().unwrap_or("Decision"),
                "owner",
                now,
                d.clone(),
            )?;
        }
        _ => return Err(bad("Unknown execution job type")),
    }
    j["status"] = json!("done");
    j["result"] = result.clone();
    j["finished_at"] = json!(now);
    save(db, "jobs", &id, &j)?;
    if let Some(rid) = j["payload"]["execution"]["run_id"]
        .as_str()
        .or_else(|| j["payload"]["candidate"]["run_id"].as_str())
        .or_else(|| j["payload"]["run_id"].as_str())
    {
        super::comparison::wake(db, rid, now)?;
    }
    event(
        db,
        "job.completed",
        now,
        json!({"id":id,"kind":j["kind"],"epoch":j["epoch"]}),
    )?;
    Ok(json!({"status":"completed","id":id}))
}

/// Record independently observed canonical publication, including its graph and site projection.
pub(super) fn record_publication<S: SqlStore>(
    db: &S,
    repository: &mut Value,
    decision: &mut Value,
    now: i64,
) -> Result<()> {
    let did = string(decision, "id")?;
    let commit = string(&decision["target"], "commit")?;
    repository["head_commit"] = json!(commit);
    repository["published_commit"] = json!(commit);
    repository["pending"] = Value::Null;
    repository["status"] = json!("ready");
    repository["site"] = Value::Null;
    repository["app"] = Value::Null;
    decision["status"] = json!("published");
    decision["published_at"] = json!(now);
    super::branches::published(db, repository, now)?;
    super::history::link_file_provenance_to_publication(db, decision, &commit)?;
    let candidate = get(db, "candidates", &string(decision, "candidate")?)?;
    let evaluation = get(db, "evaluations", &string(&candidate, "evaluation")?)?;
    if evaluation["deployment"]["commit"] == commit
        && evaluation["deployment"]["digest"].is_string()
    {
        repository["site"] = evaluation["deployment"].clone();
    }
    if evaluation["app"]["revision"] == commit && evaluation["app"]["bundle_digest"].is_string() {
        repository["app"] = evaluation["app"].clone();
    }
    for path in crate::path_lists::load(db, &candidate, "paths")? {
        edge(
            db,
            &did,
            &format!("source:{commit}:{path}"),
            "published_as",
            "canonical Git HEAD independently read back",
        )?;
    }
    Ok(())
}
#[cfg(test)]
pub(super) mod source_tests;
