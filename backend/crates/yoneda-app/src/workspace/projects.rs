use super::*;
use crate::storage::create;
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    if c["op"] == "workspace_capabilities" {
        return Ok(json!({"version":1,"capabilities":{"guided_projects":1}}));
    }
    if c["op"] == "projects" {
        let include_hidden = c["include_hidden"] == true;
        let rows = db.query(
            "SELECT payload FROM workspace_records WHERE id LIKE 'project:%' AND json_extract(payload,'$.status')!='deleted' AND (?=1 OR COALESCE(json_extract(payload,'$.hidden'),0)!=1) ORDER BY id LIMIT 100",
            &[json!(if include_hidden { 1 } else { 0 })],
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
        let mut result = json!({"projects":projects});
        if include_hidden {
            result["include_hidden"] = json!(true);
            result["includes_hidden"] = json!(true);
        }
        return Ok(result);
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
            let guided = guided_project(c)?;
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
                    || existing["guided_project"] != guided
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
            let mut p = json!({"id":id,"name":name,"status":"provisioning","stage":"queued","setup_started_at":now,"created_at":now,"updated_at":now,"source":source,"policy":c["policy"]});
            if !guided.is_null() {
                if !source.is_null() {
                    return Err(bad("Guided projects must fork their fixed starter"));
                }
                p["guided_project"] = guided;
            }
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

// Only the Worker adapter supplies this private marker after SDK/R2 readback.
fn guided_project(c: &Value) -> Result<Value> {
    let value = c.get("_guided_project").cloned().unwrap_or(Value::Null);
    if value.is_null() {
        return Ok(value);
    }
    let oid = |v: &Value| {
        v.as_str().is_some_and(|s| {
            s.len() == 40
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    };
    if value["profile_id"] != yoneda_core::guided::PROFILE_ID
        || !yoneda_core::guided::supported_version(&value["version"])
        || !oid(&value["starter"]["commit"])
        || !oid(&value["starter"]["tree"])
        || value["starter"]["repository"].as_str().is_none_or(|s| {
            s.len() > 256
                || s.split('/').count() != 2
                || s.split('/').any(|part| {
                    part.is_empty()
                        || part == "."
                        || part == ".."
                        || !part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                })
        })
        || value["starter"]["branch"].as_str().is_none_or(|s| {
            s.is_empty()
                || s.len() > 255
                || s.contains("..")
                || s.contains("@{")
                || s.split('/').any(|part| {
                    part.is_empty()
                        || part.starts_with('.')
                        || part.ends_with('.')
                        || part.ends_with(".lock")
                })
                || s.bytes()
                    .any(|b| b <= b' ' || b == 127 || b"~^:?*[\\".contains(&b))
        })
        || value["policy_digest"] != yoneda_core::fingerprint(&c["policy"])?
        || c["policy"]["version"] != yoneda_core::guided::PROFILE_ID
        || value["test_bundle_digest"] != c["policy"]["build"]["test_bundle"]["digest"]
        || value["test_bundle_digest"]
            .as_str()
            .is_none_or(|s| s.len() != 64)
    {
        return Err(bad("Invalid fixed guided project metadata"));
    }
    Ok(value)
}

#[cfg(test)]
#[path = "guided_project_tests.rs"]
mod guided_project_tests;
