use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
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
            let r = json!({"id":id,"name":name,"workspace":workspace,"remote":c["remote"],"head_commit":commit,"published_commit":commit,"version":0,"policy":policy,"pending":null,"status":"ready"});
            create(db, "repository", "repo", &r)?;
            node(db, &id, "repository", &name, "owner", now, r.clone())?;
            event(db, "repository.created", now, json!({"id":id}))?;
            Ok(r)
        }
        "snapshot" => {
            let r = repo(db)?;
            let edges = db.query(
                "SELECT source,target,relation,evidence FROM edges LIMIT 4000",
                &[],
            )?;
            let seq = db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events", &[])?;
            Ok(
                json!({"v":1,"capabilities":{"artifact_reads":2,"workspace_authority":1},"repository":r,"runs":all(db,"runs")?,"executions":all(db,"executions")?,"candidates":all(db,"candidates")?,"evaluations":all(db,"evaluations")?,"decisions":all(db,"decisions")?,"artifacts":all(db,"artifacts")?,"nodes":all(db,"nodes")?,"edges":edges,"seq":seq[0]["seq"]}),
            )
        }
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
}
