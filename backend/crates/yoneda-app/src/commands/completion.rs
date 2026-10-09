use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
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
        "agent" => {
            let eid = string(&j["payload"]["execution"], "id")?;
            let mut e = get(db, "executions", &eid)?;
            let run_id = string(&e, "run_id")?;
            let mut run = get(db, "runs", &run_id)?;
            e["status"] = json!("completed");
            e["finished_at"] = json!(now);
            if result.get("transcript").is_some() {
                e["transcript"] = json!(hash(result, "transcript", &[64])?);
            }
            if e["role"] == "research" {
                let context: Vec<_> = all(db, "artifacts")?
                    .iter()
                    .filter(|a| a["producer"] == eid)
                    .map(|a| a["id"].clone())
                    .collect();
                if context.is_empty() {
                    return Err(Error::new(
                        "MISSING_CONTEXT",
                        "Research must publish an artifact through MCP",
                    ));
                }
                for (h, s) in [
                    ("codex", "minimal"),
                    ("claude", "defensive"),
                    ("codex", "maintainable"),
                ] {
                    execution(db, &run, h, s, "coding", json!(context), now)?;
                }
                run["status"] = json!("exploring");
            } else {
                let workspace = hash(result, "workspace", &[64])?;
                job(
                    db,
                    &format!("capture:{eid}"),
                    "capture",
                    now,
                    json!({"execution":e,"run_id":run_id,"base":run["base"],"workspace":workspace}),
                )?;
                e["status"] = json!("capturing");
            }
            save(db, "runs", &run_id, &run)?;
            save_execution(db, &e, now)?;
        }
        "capture" => {
            let cid = string(result, "id")?;
            let execution = &j["payload"]["execution"];
            let eid = string(execution, "id")?;
            let run_id = string(execution, "run_id")?;
            hash(&result["revision"], "commit", &[40, 64])?;
            string(&result["revision"], "repository")?;
            hash(result, "tree", &[40, 64])?;
            let paths = result["paths"]
                .as_array()
                .ok_or_else(|| bad("Capture must enumerate changed paths"))?;
            for path in paths {
                yoneda_core::validate_path(
                    path.as_str().ok_or_else(|| bad("Invalid changed path"))?,
                )?;
            }
            let candidate = json!({"id":cid,"execution":eid,"run_id":run_id,"base":j["payload"]["base"],"revision":result["revision"],"tree":result["tree"],"paths":paths,"diff":result["diff"],"summary":result["summary"],"status":"evaluating"});
            create(db, "candidates", &cid, &candidate)?;
            node(
                db,
                &cid,
                "candidate",
                result["summary"].as_str().unwrap_or("Candidate"),
                "platform_capture",
                now,
                candidate.clone(),
            )?;
            edge(db, &eid, &cid, "produced_by", "independent source capture")?;
            let mut e = get(db, "executions", &eid)?;
            e["status"] = json!("evaluating");
            save_execution(db, &e, now)?;
            // Coding keeps its approved brief, while eligibility must use current
            // owner policy even if that policy changed before capture existed.
            let policy = repo(db)?["policy"].clone();
            job(
                db,
                &format!("evaluate:{cid}"),
                "evaluate",
                now,
                json!({"candidate":candidate,"run_id":run_id,"policy":policy}),
            )?;
        }
        "evaluate" => {
            let candidate_id = string(&j["payload"]["candidate"], "id")?;
            let mut candidate = get(db, "candidates", &candidate_id)?;
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
                candidate["status"] = json!(if validation.is_ok() {
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
            let rid = string(&candidate, "run_id")?;
            let mut run = get(db, "runs", &rid)?;
            if run["status"] != "accepted" {
                run["status"] = json!("ready");
            }
            save(db, "runs", &rid, &run)?;
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
                r["published_commit"] = result["commit"].clone();
                r["pending"] = Value::Null;
                d["status"] = json!("published");
                d["published_at"] = json!(now);
                let candidate = get(db, "candidates", &string(&d, "candidate")?)?;
                let evaluation = get(db, "evaluations", &string(&candidate, "evaluation")?)?;
                if evaluation["deployment"]["commit"] == d["target"]["commit"]
                    && evaluation["deployment"]["digest"].is_string()
                {
                    r["site"] = evaluation["deployment"].clone();
                }
                for path in candidate["paths"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    let anchor = format!("source:{}:{path}", string(&d["target"], "commit")?);
                    edge(
                        db,
                        &did,
                        &anchor,
                        "published_as",
                        "canonical Git HEAD independently read back",
                    )?;
                }
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
    event(
        db,
        "job.completed",
        now,
        json!({"id":id,"kind":j["kind"],"epoch":j["epoch"]}),
    )?;
    Ok(json!({"status":"completed","id":id}))
}
