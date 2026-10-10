use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::agents::*;
use yoneda_core::{Error, Result};
pub(super) fn capabilities<S: SqlStore>(db: &S, now: i64) -> Result<Value> {
    Ok(
        json!({"artifact_reads":2,"workspace_authority":1,"model_budgets":1,"max_execution_ms":yoneda_core::model_budget::MAX_MODEL_EXECUTION_MS,"optional_model_requests":1,"published_continuation":1,"context_usage":1,"collaborative_runs":1,"team_planning":1,"context_usage_since":super::context_access::activation(db,now)?,"agent_limits":{"min_root_agents":MIN_ROOT_AGENTS,"max_root_agents":MAX_ROOT_AGENTS,"max_run_executions":MAX_RUN_EXECUTIONS,"max_delegation_depth":MAX_DELEGATION_DEPTH,"max_run_model_requests":null}}),
    )
}
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "init" => {
            let id = string(&c, "id")?;
            let name = string(&c, "name")?;
            let commit = hash(&c, "commit", &[40, 64])?;
            string(&c["remote"], "namespace")?;
            string(&c["remote"], "name")?;
            let policy: yoneda_core::Policy =
                serde_json::from_value(c["policy"].clone()).map_err(|e| bad(&e.to_string()))?;
            yoneda_core::build::validate_policy(&policy)?;
            let workspace = c
                .get("workspace")
                .and_then(Value::as_str)
                .unwrap_or("_admin");
            let mut r = json!({"id":id,"name":name,"workspace":workspace,"remote":c["remote"],"head_commit":commit,"published_commit":commit,"version":0,"policy":policy,"pending":null,"status":"ready"});
            if let Some(transport) = c.get("workspace_transport") {
                if transport != "git-native-v1" {
                    return Err(bad("Unsupported workspace transport"));
                }
                r["workspace_transport"] = transport.clone();
            }
            super::study::initialize(&c, &mut r)?;
            create(db, "repository", "repo", &r)?;
            node(db, &id, "repository", &name, "owner", now, r.clone())?;
            event(db, "repository.created", now, json!({"id":id}))?;
            Ok(r)
        }
        "snapshot" => {
            let r = repo(db)?;
            let mut edges = db.query(
                "SELECT source,target,relation,evidence FROM edges ORDER BY source,target,relation LIMIT 4001",
                &[],
            )?;
            let edges_truncated = edges.len() > 4000;
            edges.truncate(4000);
            let edge_count =
                db.query("SELECT COUNT(*) AS count FROM edges", &[])?[0]["count"].clone();
            let seq = crate::storage::checked_watermark(
                db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events", &[])?[0]["seq"]
                    .as_i64()
                    .unwrap_or_default(),
            )?;
            Ok(
                json!({"v":1,"capabilities":capabilities(db,now)?,"repository":r,"runs":all(db,"runs")?,"executions":all(db,"executions")?,"team_tasks":all(db,"team_tasks")?,"team_handoffs":all(db,"team_handoffs")?,"candidates":all(db,"candidates")?,"evaluations":all(db,"evaluations")?,"decisions":all(db,"decisions")?,"artifacts":all(db,"artifacts")?,"nodes":all(db,"nodes")?,"edges":edges,"edge_count":edge_count,"edges_truncated":edges_truncated,"seq":seq}),
            )
        }
        "repository_overview" => {
            let mut value = crate::storage::repository_overview(db)?;
            value["v"] = json!(1);
            value["capabilities"] = capabilities(db, now)?;
            Ok(value)
        }
        "runs_page" => {
            let cursor = c.get("cursor").and_then(Value::as_str);
            let limit = match c.get("limit") {
                Some(v) => v
                    .as_u64()
                    .filter(|n| (1..=200).contains(n))
                    .ok_or_else(|| bad("Run page limit must be between 1 and 200"))?
                    as usize,
                None => 50,
            };
            crate::storage::run_page(
                db,
                cursor,
                limit,
                c.get("watermark").and_then(Value::as_i64),
            )
        }
        "run_detail" => {
            let mut value = crate::storage::run_detail(db, &string(&c, "run_id")?)?;
            let seq = crate::storage::checked_watermark(
                db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events", &[])?[0]["seq"]
                    .as_i64()
                    .unwrap_or_default(),
            )?;
            value["capabilities"] = capabilities(db, now)?;
            value["seq"] = json!(seq);
            Ok(value)
        }
        "candidate_record" => get(db, "candidates", &string(&c, "id")?),
        "run_graph_page" => {
            let limit = match c.get("limit") {
                Some(v) => v
                    .as_u64()
                    .filter(|n| (1..=200).contains(n))
                    .ok_or_else(|| bad("Graph page limit must be between 1 and 200"))?
                    as usize,
                None => 50,
            };
            crate::storage::run_graph_page(
                db,
                &string(&c, "run_id")?,
                c.get("cursor").and_then(Value::as_str),
                limit,
                c.get("watermark").and_then(Value::as_i64),
            )
        }
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
}
