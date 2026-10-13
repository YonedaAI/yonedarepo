use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::agents::DelegationPolicy;
use yoneda_core::{Error, Result};
const MAX_ACTIVE_WORK_RUNS: i64 = 6;
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "start_run" => {
            let r = repo(db)?;
            if !r["pending"].is_null() {
                return Err(Error::new(
                    "PUBLICATION_PENDING",
                    "Wait for verified publication before starting another run",
                ));
            }
            if r["status"] != "ready" {
                return Err(Error::new(
                    "REPOSITORY_BLOCKED",
                    "Resolve remote divergence before starting work",
                ));
            }
            let continuation_of = super::continuations::validate(db, &c, &r)?;
            let restart_of = super::restarts::validate(db, &c)?;
            let working_branch = super::branches::freeze(db, &c)?;
            let id = string(&c, "id")?;
            let intent = string(&c, "intent")?;
            let general = !r["policy"]["build"].is_null();
            let criteria = c.get("criteria").cloned().unwrap_or(json!([]));
            let criteria_array = criteria
                .as_array()
                .ok_or_else(|| bad("Criteria must be an array"))?;
            if criteria_array.len() > 32
                || criteria_array.iter().any(|v| {
                    v.as_str()
                        .is_none_or(|s| s.trim().is_empty() || s.len() > 2048)
                })
            {
                return Err(bad("Criteria must be bounded statements"));
            }
            let context = c.get("context").cloned().unwrap_or(json!([]));
            let references = context
                .as_array()
                .ok_or_else(|| bad("Context must be an array"))?;
            if references.len() > 50 {
                return Err(bad("At most 50 context records per run"));
            }
            let mut records = Vec::new();
            for reference in references {
                records.push(get(
                    db,
                    "nodes",
                    reference
                        .as_str()
                        .ok_or_else(|| bad("Invalid context ID"))?,
                )?);
            }
            if general {
                super::scheduling::validate_agents(&c)?;
            }
            let team = super::team::freeze(&c, general)?;
            let collaborate = c["mode"] == "collaborate";
            let automatic = collaborate && team.is_none();
            if collaborate && r.get("context_study").is_some() {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Controlled context trials do not support team mode",
                ));
            }
            let model_budgets = super::model_budgets::freeze(&c, general)?;
            let root_count = if general {
                c["agents"].as_array().map_or(0, Vec::len)
            } else {
                1
            };
            let delegation = c
                .get("delegation")
                .map(|value| {
                    serde_json::from_value::<DelegationPolicy>(value.clone())
                        .map_err(|e| bad(&e.to_string()))
                })
                .transpose()?
                .unwrap_or_else(|| DelegationPolicy::disabled(root_count));
            delegation.validate(root_count)?;
            if !general && delegation.enabled {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Only hosted coding runs may delegate",
                ));
            }
            if active_run_count(db)? >= MAX_ACTIVE_WORK_RUNS {
                return Err(Error::new(
                    "ACTIVE_RUN_LIMIT",
                    "Repository already has six active work runs",
                ));
            }
            let remote = format!(
                "{}/{}",
                string(&r["remote"], "namespace")?,
                string(&r["remote"], "name")?
            );
            let mut run = json!({"id":id,"intent":intent,"criteria":criteria,"context":context,"context_records":records,"policy":r["policy"],"base":{"repository":remote,"commit":r["published_commit"]},"base_version":r["version"],"status":if automatic {"planning"} else if general {"exploring"} else {"researching"},"created_at":now,"delegation":delegation,"execution_count":root_count,"model_requests":0,"context_usage_version":1,"mode":if collaborate {"collaborate"} else {"compare"}});
            if collaborate {
                run["approved_policy"] = run["policy"].clone();
            }
            if general {
                run["agents"] = c["agents"].clone();
            }
            if let Some(transport) = c
                .get("workspace_transport")
                .or_else(|| r.get("workspace_transport"))
            {
                if transport != "git-native-v1" {
                    return Err(bad("Unsupported workspace transport"));
                }
                run["workspace_transport"] = transport.clone();
            }
            if automatic {
                run["team_planning"] = json!("automatic");
                run["execution_count"] = json!(1);
            }
            if let Some(plan) = &team {
                super::team::validate_plan_scopes(&run, plan)?;
                run["team_plan"] = json!(plan);
                run["team_plan_revision"] = json!(1);
                run["execution_count"] = json!(plan.tasks.len() + 1);
            }
            if let Some(budgets) = model_budgets {
                run["model_budgets"] = json!(budgets);
                run["request_limits"] = json!("optional-v1");
            }
            if c["_workspace_spend"] == true {
                run["workspace_spend"] = json!({"version":1});
            }
            if let Some(profile) = c.get("_sample_profile") {
                run["sample_profile"] = profile.clone();
            }
            if let Some(branch) = &working_branch {
                run["working_branch_id"] = branch["id"].clone();
                run["working_branch_version"] = branch["version"].clone();
                run["base"] = branch["working_revision"].clone();
            }
            super::adaptive_team::freeze(&c, &mut run)?;
            super::autonomy::freeze(&c, &mut run)?;
            super::campaign::freeze(db, &c, &mut run, now)?;
            if run["autonomy_approval"].is_object() {
                run["autonomy_approval"]["model_budgets"] = run["model_budgets"].clone();
                if !run["repair_escalation"].is_null() {
                    run["autonomy_approval"]["repair_escalation"] =
                        run["repair_escalation"].clone();
                }
            }
            if r.get("context_study").is_none()
                && (working_branch.is_some() || run["autonomy_policy"]["enabled"] == true)
            {
                super::context_packet::freeze(db, &mut run, working_branch.as_ref())?;
            }
            if let Some(previous) = &restart_of {
                run["restart_of"] = json!(previous);
            }
            if let Some(decision) = &continuation_of {
                run["continuation_of"] = json!(decision);
            }
            super::study::apply(&mut run, super::study::freeze(db, &r)?);
            super::study::select(&c, &r, &mut run)?;
            create(db, "runs", &id, &run)?;
            let intent_id = format!("intent:{id}");
            node(
                db,
                &intent_id,
                "intent",
                &intent,
                "owner",
                now,
                json!({"criteria":run["criteria"]}),
            )?;
            node(db, &id, "run", &intent, "platform", now, run.clone())?;
            edge(db, &intent_id, &id, "implements", "owner request")?;
            if let Some(previous) = restart_of {
                edge(
                    db,
                    &previous,
                    &id,
                    "restarts",
                    "owner-approved fresh run on current canonical source",
                )?;
            }
            if let Some(decision) = continuation_of {
                edge(
                    db,
                    &decision,
                    &id,
                    "continues",
                    "owner-approved update from the published decision",
                )?;
            }
            if general {
                if automatic {
                    super::team::start_planner(db, &run, now)?;
                } else if team.is_some() {
                    super::team::start(db, &run, now)?;
                } else {
                    super::scheduling::schedule(db, &run, &c["agents"], now)?;
                }
            } else {
                execution(db, &run, "claude", "research", "research", json!([]), now)?;
            }
            event(db, "run.created", now, run.clone())?;
            Ok(run)
        }
        "cancel_run" => {
            let id = string(&c, "run_id")?;
            let mut r = get(db, "runs", &id)?;
            if r["status"] == "accepted" {
                return Err(Error::new(
                    "INVALID_STATE",
                    "Accepted runs cannot be cancelled",
                ));
            }
            r["status"] = json!("cancelled");
            save(db, "runs", &id, &r)?;
            let mut stops = Vec::new();
            for mut j in run_jobs(db, &id)? {
                if j["status"] == "queued" || j["status"] == "running" {
                    let jid = string(&j, "id")?;
                    stops.push(json!({"job_id":jid,"epoch":j["epoch"]}));
                    cancel_job(db, &mut j, now)?;
                    if let Some(eid) = j["payload"]["execution"]["id"]
                        .as_str()
                        .or_else(|| j["payload"]["candidate"]["execution"].as_str())
                    {
                        let mut e = get(db, "executions", eid)?;
                        e["status"] = json!("cancelled");
                        save_execution(db, &e, now)?;
                    }
                    if let Some(cid) = j["payload"]["candidate"]["id"].as_str() {
                        let mut candidate = get(db, "candidates", cid)?;
                        candidate["status"] = json!("cancelled");
                        save(db, "candidates", cid, &candidate)?;
                    }
                }
            }
            for mut execution in run_executions(db, &id)? {
                execution["status"] = json!("cancelled");
                save_execution(db, &execution, now)?;
            }
            let rows = db.query(
                "SELECT payload FROM candidates WHERE json_extract(payload,'$.run_id')=?",
                &[json!(id)],
            )?;
            for row in rows {
                let mut candidate: Value = serde_json::from_str(
                    row["payload"]
                        .as_str()
                        .ok_or_else(|| bad("Corrupt candidate"))?,
                )
                .map_err(|e| bad(&e.to_string()))?;
                candidate["status"] = json!("cancelled");
                save(db, "candidates", &string(&candidate, "id")?, &candidate)?;
            }
            if r["mode"] == "collaborate" {
                super::team::cancelled(db, &id, now)?;
            }
            event(db, "run.cancelled", now, json!({"id":id}))?;
            Ok(json!({"status":"cancelled","stop":stops}))
        }
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
}
