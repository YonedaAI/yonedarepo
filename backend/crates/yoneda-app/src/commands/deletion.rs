//! Permanent repository tombstones fence callbacks before asynchronous cleanup starts.
use crate::storage::*;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use yoneda_core::{Error, Result};

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
    let namespace = string(&repository["remote"], "namespace")?;
    let mut remotes = BTreeSet::new();
    // Managed personal repositories have immutable names derived from workspace request IDs.
    // Legacy administrator repositories may point to shared Git sources; retain those remotes.
    if workspace != "_admin" && repository["remote"]["name"] == id {
        remotes.insert(id.clone());
    }
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
        if job["kind"] == "capture" {
            for epoch in 1..=number(&job, "attempt")?.min(2) {
                let digest = yoneda_core::digest(format!("{id}:{job_id}:{epoch}").as_bytes());
                remotes.insert(format!("candidate-{}", &digest[..32]));
            }
        }
        if job["external"] == true {
            let execution = string(&job["payload"]["execution"], "id")?;
            let digest = yoneda_core::digest(execution.as_bytes());
            let name = format!("contribution-{}", &digest[..32]);
            if job["external_fork"] == format!("{namespace}/{name}") {
                remotes.insert(name);
            }
        }
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
    repository["deletion_remotes"] = json!(remotes);
    repository["cleanup_generation"] = json!(0);
    repository["cleanup_cycle"] = json!(0);
    repository["next_cleanup_at"] = json!(now.saturating_add(60_000));
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
    for name in remotes {
        outbox(
            db,
            &format!("delete:artifact:{name}"),
            "delete_artifact",
            json!({"name":name}),
        )?;
    }
    status(db)
}

pub(super) fn status<S: SqlStore>(db: &S) -> Result<Value> {
    let repository = repo(db)?;
    let pending = db.query("SELECT id FROM outbox WHERE delivered=0 LIMIT 1", &[])?;
    Ok(json!({"id":repository["id"],"status":repository["status"],
        "cleanup_pending":!pending.is_empty(),"deleted_at":repository["deleted_at"]}))
}

pub(super) fn retry_cleanup<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let mut repository = repo(db)?;
    if repository["status"] != "deleted" {
        return Err(Error::new(
            "INVALID_STATE",
            "Repository has not been deleted",
        ));
    }
    let name = string(c, "name")?;
    if repository["deletion_remotes"]
        .as_array()
        .is_none_or(|names| !names.contains(&json!(name)))
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Remote is not owned by this deletion",
        ));
    }
    enqueue_cleanup(db, &mut repository, &[json!(name)])?;
    status(db)
}

/// Periodic reclamation catches asynchronous provider operations that outlive their callers.
pub(super) fn recover<S: SqlStore>(db: &S, now: i64) -> Result<Value> {
    let mut repository = repo(db)?;
    if repository["next_cleanup_at"]
        .as_i64()
        .is_some_and(|at| at <= now)
    {
        let names = repository["deletion_remotes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let cycle = number(&repository, "cleanup_cycle")?
            .saturating_add(1)
            .min(8);
        repository["cleanup_cycle"] = json!(cycle);
        let interval = (0..cycle)
            .fold(60_000_i64, |delay, _| delay.saturating_mul(5))
            .min(86_400_000);
        repository["next_cleanup_at"] = json!(now.saturating_add(interval));
        enqueue_cleanup(db, &mut repository, &names)?;
    }
    Ok(json!({"recovered":0}))
}

fn enqueue_cleanup<S: SqlStore>(db: &S, repository: &mut Value, names: &[Value]) -> Result<()> {
    let generation = number(repository, "cleanup_generation")?
        .checked_add(1)
        .ok_or_else(|| bad("Cleanup generation overflow"))?;
    repository["cleanup_generation"] = json!(generation);
    for name in names {
        let name = name.as_str().ok_or_else(|| bad("Invalid cleanup remote"))?;
        // New IDs fence acknowledgments from an earlier sweep or lost creation response.
        db.query(
            "DELETE FROM outbox WHERE kind='delete_artifact' AND json_extract(payload,'$.name')=?",
            &[json!(name)],
        )?;
        outbox(
            db,
            &format!("delete:artifact:{name}:{generation}"),
            "delete_artifact",
            json!({"name":name}),
        )?;
    }
    db.query(
        "DELETE FROM outbox WHERE delivered=1 AND kind='delete_artifact'",
        &[],
    )?;
    save(db, "repository", "repo", repository)
}
