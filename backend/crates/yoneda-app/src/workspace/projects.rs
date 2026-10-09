use super::*;
use crate::storage::create;
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    if c["op"] == "projects" {
        let rows = db.query(
            "SELECT payload FROM workspace_records WHERE id LIKE 'project:%' AND json_extract(payload,'$.status')!='deleted' ORDER BY id LIMIT 100",
            &[],
        )?;
        let projects = rows
            .iter()
            .map(|row| {
                serde_json::from_str::<Value>(
                    row["payload"]
                        .as_str()
                        .ok_or_else(|| bad("Corrupt project"))?,
                )
                .map_err(|e| bad(&e.to_string()))
            })
            .collect::<Result<Vec<_>>>()?;
        return Ok(json!({"projects":projects}));
    }
    let id = string(c, "id")?;
    if id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(bad("Invalid project ID"));
    }
    let key = format!("project:{id}");
    match string(c, "op")?.as_str() {
        "project_reserve" => {
            let name = string(c, "name")?;
            if name.len() > 100 {
                return Err(bad("Project name exceeds 100 bytes"));
            }
            let policy: yoneda_core::Policy =
                serde_json::from_value(c["policy"].clone()).map_err(|e| bad(&e.to_string()))?;
            yoneda_core::build::validate_policy(&policy)?;
            let source = c.get("source").cloned().unwrap_or(Value::Null);
            if let Ok(existing) = get(db, TABLE, &key) {
                if existing["status"] == "deleted" {
                    return Err(Error::new(
                        "REPOSITORY_DELETED",
                        "This repository has been deleted",
                    ));
                }
                if existing["name"] != name
                    || existing["source"] != source
                    || existing["policy"] != c["policy"]
                {
                    return Err(bad("Project request ID reused with different input"));
                }
                return Ok(existing);
            }
            let n = db.query(
                "SELECT COUNT(*) AS n FROM workspace_records WHERE id LIKE 'project:%' AND json_extract(payload,'$.status')!='deleted'",
                &[],
            )?;
            if n[0]["n"].as_i64().unwrap_or_default() >= 100 {
                return Err(bad("Workspace project limit reached"));
            }
            let p = json!({"id":id,"name":name,"status":"provisioning","stage":"queued","setup_started_at":now,"created_at":now,"updated_at":now,"source":source,"policy":c["policy"]});
            create(db, TABLE, &key, &p)?;
            Ok(p)
        }
        "project_get" => get(db, TABLE, &key),
        "project_dispatch_sent" => super::project_dispatch::sent(db, c, &key, now),
        "project_delete" => {
            let mut p = get(db, TABLE, &key)?;
            if p["status"] != "deleted" {
                p["status"] = json!("deleted");
                p["deleted_at"] = json!(now);
                p["error"] = Value::Null;
                put(db, &key, &p)?;
                db.query("UPDATE workspace_records SET payload=json_set(payload,'$.revoked',json('true')) WHERE id LIKE 'grant:%' AND json_extract(payload,'$.repo')=?", &[json!(id)])?;
                audit(db, "project.deleted", now, json!({"id":id}))?;
            }
            Ok(p)
        }
        "project_update" | "project_claim" | "project_progress" | "project_retry"
        | "project_schedule" => super::project_setup::handle(db, c, &key, now),
        _ => Err(bad("Unknown project operation")),
    }
}
