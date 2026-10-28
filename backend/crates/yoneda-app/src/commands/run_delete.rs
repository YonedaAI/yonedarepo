//! Owner deletion of one finished run. Every ledger row keyed to the run goes in the caller's
//! transaction; published source and the canonical head are never touched. The adapter then
//! removes the run's attempt branches and archived history from the `run_delete` outbox entry.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};

#[path = "run_delete/purge.rs"]
mod purge;
use purge::{node_ids, purge};

const FINISHED: [&str; 4] = ["accepted", "cancelled", "failed", "ready"];
const ACTIVE_EXECUTION: &str = "('queued','provisioning','running','capturing','evaluating')";

/// The run's own records, by table, with the commits only this run produced.
struct Owned {
    executions: Vec<String>,
    candidates: Vec<String>,
    evaluations: Vec<String>,
    decisions: Vec<String>,
    artifacts: Vec<String>,
    jobs: Vec<String>,
    team_tasks: Vec<String>,
    team_handoffs: Vec<String>,
    /// Candidate commits that never became published source.
    unpublished: Vec<String>,
}

pub(super) fn delete<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let repository = repo(db)?;
    let owner = c["_workspace"].as_str().ok_or_else(forbidden)?;
    if (owner != "_admin" && repository["workspace"] != owner)
        || ["_grant", "job_id", "_reviewer"]
            .iter()
            .any(|key| c.get(key).is_some())
    {
        return Err(forbidden());
    }
    let id = string(c, "run_id")?;
    let run = get(db, "runs", &id)?;
    let owned = Owned::load(db, &id, &repository)?;
    ensure_settled(db, &run, &owned, &repository)?;
    let nodes = node_ids(db, &id, &owned)?;
    ensure_independent(db, &id, &owned, &nodes)?;
    // A branch whose head is this run's published result keeps that head; it just no longer
    // names the deleted candidate, exactly like a branch opened on published source.
    db.query(
        "UPDATE working_branches SET payload=json_set(payload,'$.latest_candidate_id',NULL) WHERE json_extract(payload,'$.latest_candidate_id') IN (SELECT value FROM json_each(?))",
        &[list(&owned.candidates)],
    )?;
    purge(db, &id, &owned, &nodes)?;
    let repository_id = string(&repository, "id")?;
    outbox(
        db,
        &format!("run_delete:{id}:{now}"),
        "run_delete",
        json!({"run_id":id,"workspace":repository["workspace"],
            "archive_key":format!("history/{repository_id}/{id}.json")}),
    )?;
    event(db, "run.deleted", now, json!({"id":id}))?;
    Ok(json!({"run_id":id,"deleted":true}))
}

fn forbidden() -> Error {
    Error::new(
        "FORBIDDEN",
        "Only the authenticated repository owner may delete a run",
    )
}

/// A JSON array parameter for `json_each(?)`, which keeps every list to one bound value.
fn list(ids: &[String]) -> Value {
    json!(json!(ids).to_string())
}

fn ids<S: SqlStore>(db: &S, sql: &str, params: &[Value]) -> Result<Vec<String>> {
    Ok(db
        .query(sql, params)?
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect())
}

impl Owned {
    fn load<S: SqlStore>(db: &S, id: &str, repository: &Value) -> Result<Self> {
        let run = json!(id);
        let scoped = |table: &str| {
            ids(
                db,
                &format!("SELECT id FROM {table} WHERE json_extract(payload,'$.run_id')=?"),
                std::slice::from_ref(&run),
            )
        };
        let executions = scoped("executions")?;
        let candidate_rows = db.query("SELECT id,json_extract(payload,'$.revision.commit') AS revision FROM candidates WHERE json_extract(payload,'$.run_id')=?", std::slice::from_ref(&run))?;
        let candidates: Vec<String> = candidate_rows
            .iter()
            .filter_map(|row| row["id"].as_str().map(str::to_owned))
            .collect();
        let decision_rows = db.query("SELECT id,json_extract(payload,'$.status') AS status,json_extract(payload,'$.target.commit') AS target FROM decisions WHERE json_extract(payload,'$.run_id')=?", std::slice::from_ref(&run))?;
        let published: Vec<&str> = decision_rows
            .iter()
            .filter(|row| row["status"] == "published")
            .filter_map(|row| row["target"].as_str())
            .chain(repository["published_commit"].as_str())
            .collect();
        let mut unpublished: Vec<String> = candidate_rows
            .iter()
            .filter_map(|row| row["revision"].as_str())
            .filter(|commit| !published.contains(commit))
            .map(str::to_owned)
            .collect();
        unpublished.sort();
        unpublished.dedup();
        let producers = list(&executions);
        Ok(Self {
            evaluations: ids(
                db,
                "SELECT id FROM evaluations WHERE json_extract(payload,'$.run_id')=? OR json_extract(payload,'$.candidate') IN (SELECT value FROM json_each(?))",
                &[run.clone(), list(&candidates)],
            )?,
            artifacts: ids(
                db,
                "SELECT id FROM artifacts WHERE json_extract(payload,'$.run_id')=? OR json_extract(payload,'$.producer') IN (SELECT value FROM json_each(?)) OR json_extract(payload,'$.producer.execution') IN (SELECT value FROM json_each(?)) OR json_extract(payload,'$.producer.execution.id') IN (SELECT value FROM json_each(?))",
                &[run.clone(), producers.clone(), producers.clone(), producers],
            )?,
            jobs: run_jobs(db, id)?
                .iter()
                .filter_map(|job| job["id"].as_str().map(str::to_owned))
                .collect(),
            decisions: decision_rows
                .iter()
                .filter_map(|row| row["id"].as_str().map(str::to_owned))
                .collect(),
            team_tasks: scoped("team_tasks")?,
            team_handoffs: scoped("team_handoffs")?,
            executions,
            candidates,
            unpublished,
        })
    }
}

fn ensure_settled<S: SqlStore>(
    db: &S,
    run: &Value,
    owned: &Owned,
    repository: &Value,
) -> Result<()> {
    let active_job = db.query("SELECT id FROM jobs WHERE id IN (SELECT value FROM json_each(?)) AND COALESCE(json_extract(payload,'$.status'),'') NOT IN ('done','failed','cancelled') LIMIT 1", &[list(&owned.jobs)])?;
    let active_execution = db.query(&format!("SELECT id FROM executions WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(payload,'$.status') IN {ACTIVE_EXECUTION} LIMIT 1"), &[list(&owned.executions)])?;
    if !run["status"]
        .as_str()
        .is_some_and(|s| FINISHED.contains(&s))
        || !active_job.is_empty()
        || !active_execution.is_empty()
    {
        return Err(Error::new(
            "INVALID_STATE",
            "Cancel the run before deleting it",
        ));
    }
    if repository["pending"]
        .as_str()
        .is_some_and(|decision| owned.decisions.iter().any(|id| id == decision))
    {
        return Err(Error::new(
            "INVALID_STATE",
            "Wait for this run's publication to finish before deleting it",
        ));
    }
    Ok(())
}

/// Later work may build on an unpublished result or read the run's records as live context.
/// Published commits are canonical source, so work based on them does not depend on the run.
fn ensure_independent<S: SqlStore>(
    db: &S,
    id: &str,
    owned: &Owned,
    nodes: &[String],
) -> Result<()> {
    let commits = list(&owned.unpublished);
    let based = ids(
        db,
        "SELECT id FROM runs WHERE id!=? AND json_extract(payload,'$.base.commit') IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 1",
        &[json!(id), commits.clone()],
    )?;
    if let Some(other) = based.first() {
        return Err(depended_on(format!(
            "Run {other} builds on this run's unpublished result; delete that run first"
        )));
    }
    let branch = ids(
        db,
        "SELECT id FROM working_branches WHERE json_extract(payload,'$.working_commit') IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 1",
        &[commits],
    )?;
    if let Some(branch) = branch.first() {
        return Err(depended_on(format!(
            "Working branch {branch} continues from this run's unpublished result"
        )));
    }
    let finished = FINISHED.map(|s| format!("'{s}'")).join(",");
    let reader = ids(
        db,
        &format!(
            "SELECT DISTINCT r.id FROM runs r,json_each(r.payload,'$.context') x WHERE r.id!=? AND COALESCE(json_extract(r.payload,'$.status'),'') NOT IN ({finished}) AND x.value IN (SELECT value FROM json_each(?)) ORDER BY r.id LIMIT 1"
        ),
        &[json!(id), list(nodes)],
    )?;
    if let Some(other) = reader.first() {
        return Err(depended_on(format!(
            "Active run {other} reads this run's records as context; wait for it to finish"
        )));
    }
    Ok(())
}

fn depended_on(message: String) -> Error {
    Error::new("RUN_DEPENDED_ON", message)
}
