//! Leased setup transitions. External Artifacts I/O happens only in the Worker adapter.
use super::*;

const LEASE_MS: i64 = 120_000;
const SETUP_MS: i64 = 600_000;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, key: &str, now: i64) -> Result<Value> {
    let mut p = get(db, TABLE, key)?;
    if p["status"] == "deleted" {
        return Err(Error::new(
            "REPOSITORY_DELETED",
            "This repository has been deleted",
        ));
    }
    // A late failure or duplicate queue delivery must never regress a ready project.
    if p["status"] == "ready" {
        return Ok(p);
    }
    match string(c, "op")?.as_str() {
        "project_schedule" => {
            // One-time recovery for projects reserved before background setup existed.
            let schedule = p["status"] == "provisioning" && p["stage"].is_null();
            if schedule {
                p["stage"] = json!("queued");
                p["updated_at"] = json!(now);
                put(db, key, &p)?;
            }
            p["schedule"] = json!(schedule);
            Ok(p)
        }
        "project_retry" => {
            if p["status"] == "failed" {
                p["status"] = json!("provisioning");
                p["stage"] = json!("queued");
                p["setup_started_at"] = json!(now);
                p["next_dispatch_at"] = json!(0);
                p["lease_until"] = json!(0);
                p["error"] = Value::Null;
                p["error_code"] = Value::Null;
                p["updated_at"] = json!(now);
                put(db, key, &p)?;
            }
            Ok(p)
        }
        "project_claim" => {
            if p["status"] == "failed" || p["lease_until"].as_i64().unwrap_or(0) > now {
                p["claimed"] = json!(false);
                return Ok(p);
            }
            let started = p["setup_started_at"].as_i64().unwrap_or(now);
            if now.saturating_sub(started) >= SETUP_MS {
                p["status"] = json!("failed");
                p["stage"] = json!("failed");
                p["error_code"] = json!("SETUP_TIMEOUT");
                p["error"] = json!(
                    "Repository setup took too long. Check that the Git URL is public and has a commit on its default branch, then retry setup."
                );
                p["lease_until"] = json!(0);
                p["updated_at"] = json!(now);
                put(db, key, &p)?;
                return Ok(p);
            }
            let epoch = p["setup_epoch"]
                .as_u64()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| bad("Setup epoch exhausted"))?;
            p["setup_started_at"] = json!(started);
            p["setup_epoch"] = json!(epoch);
            p["lease_until"] = json!(now.saturating_add(LEASE_MS));
            p["stage"] = json!("checking_remote");
            p["updated_at"] = json!(now);
            put(db, key, &p)?;
            p["claimed"] = json!(true);
            Ok(p)
        }
        "project_progress" => {
            check_lease(&p, c, now)?;
            let stage = string(c, "stage")?;
            if !["creating", "importing", "checking_source", "initializing"]
                .contains(&stage.as_str())
            {
                return Err(bad("Invalid setup stage"));
            }
            p["stage"] = json!(stage);
            p["updated_at"] = json!(now);
            put(db, key, &p)?;
            Ok(p)
        }
        "project_update" => {
            if p["setup_epoch"].is_number() {
                check_lease(&p, c, now)?;
            }
            let status = string(c, "status")?;
            if !["provisioning", "ready", "failed"].contains(&status.as_str()) {
                return Err(bad("Invalid project state"));
            }
            p["status"] = json!(status);
            p["stage"] = json!(if status == "provisioning" {
                "importing"
            } else {
                &status
            });
            p["error"] = c.get("error").cloned().unwrap_or(Value::Null);
            p["error_code"] = c.get("error_code").cloned().unwrap_or(Value::Null);
            p["lease_until"] = json!(0);
            p["next_dispatch_at"] = json!(now.saturating_add(15_000));
            p["updated_at"] = json!(now);
            put(db, key, &p)?;
            Ok(p)
        }
        _ => Err(bad("Unknown setup operation")),
    }
}

fn check_lease(p: &Value, c: &Value, now: i64) -> Result<()> {
    if p["status"] != "provisioning"
        || p["setup_epoch"].as_u64().is_none()
        || p["setup_epoch"] != c["epoch"]
        || p["lease_until"].as_i64().unwrap_or(0) <= now
    {
        return Err(Error::new(
            "FENCED",
            "Repository setup attempt is no longer current",
        ));
    }
    Ok(())
}
