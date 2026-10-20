//! Permanent repository tombstones fence callbacks before asynchronous cleanup starts. Source
//! lives in the project's platform repository, which the owner manages there.
use crate::storage::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_agents_core::{Error, Result};

pub(super) fn delete<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let workspace = string(c, "_workspace")?;
    let mut repository = match repo(db) {
        Ok(repository) => repository,
        Err(error) if error.code == "NOT_FOUND" => {
            // Only the authenticated adapter supplies a workspace-owned provisioning record.
            let project = &c["project"];
            let id = string(c, "id")?;
            if project["id"] != id || workspace == "_admin" {
                return Err(Error::new("NOT_FOUND", "Unknown repository"));
            }
            json!({"id":id,"name":string(project,"name")?,"workspace":workspace,
                "remote":{"namespace":string(c,"namespace")?,"name":id},"version":0})
        }
        Err(error) => return Err(error),
    };
    if repository["workspace"].as_str().unwrap_or("_admin") != workspace {
        return Err(Error::new(
            "FORBIDDEN",
            "Repository belongs to another workspace",
        ));
    }
    if string(c, "confirm_name")? != string(&repository, "name")? {
        return Err(bad("Type the repository name exactly to confirm deletion"));
    }
    if repository["status"] == "deleted" {
        return status(db);
    }
    let id = string(&repository, "id")?;
    let mut stops = BTreeMap::new();
    for row in db.query(
        "SELECT id,payload FROM outbox WHERE delivered=0 AND kind='stop'",
        &[],
    )? {
        let payload: Value =
            serde_json::from_str(row["payload"].as_str().ok_or_else(|| bad("Corrupt stop"))?)
                .map_err(|e| bad(&e.to_string()))?;
        stops.insert(string(&row, "id")?, payload);
    }
    // Superseded dispatches must not revive work. Reinsert stops after discovery tombstones.
    db.query("DELETE FROM outbox WHERE delivered=0", &[])?;
    for row in db.query("SELECT payload FROM jobs ORDER BY id", &[])? {
        let mut job: Value =
            serde_json::from_str(row["payload"].as_str().ok_or_else(|| bad("Corrupt job"))?)
                .map_err(|e| bad(&e.to_string()))?;
        let job_id = string(&job, "id")?;
        if job["status"] == "queued" || job["status"] == "running" {
            let epoch = number(&job, "epoch")?;
            if job["status"] == "running" && job["external"] != true {
                stops.insert(
                    format!("stop:{job_id}:{epoch}"),
                    json!({"job_id":job_id,"epoch":epoch}),
                );
            }
            job["status"] = json!("cancelled");
            job["epoch"] = json!(
                epoch
                    .checked_add(1)
                    .ok_or_else(|| bad("Attempt epoch overflow"))?
            );
            job["lease_until"] = json!(0);
            save(db, "jobs", &job_id, &job)?;
        }
    }
    for table in ["runs", "executions", "candidates", "team_tasks"] {
        db.query(&format!("UPDATE {table} SET payload=json_set(payload,'$.status','cancelled') WHERE json_extract(payload,'$.status') NOT IN ('accepted','published','done','failed','cancelled')"), &[])?;
    }
    repository["version"] = json!(
        number(&repository, "version")?
            .checked_add(1)
            .ok_or_else(|| bad("Repository version overflow"))?
    );
    repository["status"] = json!("deleted");
    repository["deleted_at"] = json!(now);
    repository["pending"] = Value::Null;
    repository["site"] = Value::Null;
    save(db, "repository", "repo", &repository)?;
    // Keep monotonic discovery tombstones rather than deleting rows vulnerable to late inserts.
    event(db, "repository.deleted", now, json!({"id":id}))?;
    if workspace != "_admin" {
        outbox(
            db,
            "delete:workspace",
            "workspace_delete",
            json!({"workspace":workspace,"repo_id":id}),
        )?;
    }
    for (id, payload) in stops {
        outbox(db, &id, "stop", payload)?;
    }
    status(db)
}

pub(super) fn status<S: SqlStore>(db: &S) -> Result<Value> {
    let repository = repo(db)?;
    let pending = db.query("SELECT id FROM outbox WHERE delivered=0 LIMIT 1", &[])?;
    Ok(json!({"id":repository["id"],"status":repository["status"],
        "cleanup_pending":!pending.is_empty(),"deleted_at":repository["deleted_at"]}))
}
