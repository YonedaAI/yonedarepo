//! Sandbox team runs: a `sandbox-cli-v1` run with an owner-written task list. Each task gets
//! one unmodified coding CLI in its own sandbox, all on the run's frozen base. No agent plans,
//! messages peers, coordinates or integrates: the trusted Worker lands each member's pushed
//! commit on the run's team branch with the platform's own land operation, whose server-side
//! merge is the team's integration. The ledger keeps:
//! - each member's landing: landed, or the conflict paths, with at most one resume;
//! - once every member has landed or failed, one trusted capture of the team branch head,
//!   which becomes the run's only candidate, checked and published like any sandbox run.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::agents::DelegationPolicy;
use yoneda_agents_core::team::TeamPlan;
use yoneda_agents_core::{Error, Result};

const CONFLICT_PATHS: usize = 50;

/// Whether `run` is a sandbox team run.
pub(super) fn is_team(run: &Value) -> bool {
    run["runtime"] == super::sandbox::TRANSPORT && run["mode"] == "collaborate"
}

/// Whether a claimed job is a sandbox team member's attempt.
pub(super) fn member(job: &Value) -> bool {
    job["payload"]["execution"]["sandbox_task"].is_object()
}

/// An owner-written plan of parallel tasks, nothing that needs an orchestrating agent.
pub(super) fn freeze(
    c: &Value,
    general: bool,
    plan: Option<&TeamPlan>,
    delegation: &DelegationPolicy,
    run: &mut Value,
) -> Result<()> {
    let refuse = |message: &str| Err(Error::new("NOT_SUPPORTED", message));
    let Some(plan) = plan else {
        return refuse("Sandbox team runs take an owner-written task list, not automatic planning");
    };
    if !general || !c["comparison"].is_null() {
        return refuse("Sandbox team runs need a coding policy and no comparison review");
    }
    if delegation.enabled {
        return refuse("Sandbox runs do not delegate");
    }
    if c.get("adaptive_team").is_some_and(|v| !v.is_null())
        || c["autonomy_policy"]["enabled"] == true
    {
        return refuse(
            "Sandbox team members neither message peers nor take a coordinator: the platform merge integrates their work",
        );
    }
    if plan.tasks.iter().any(|task| !task.depends_on.is_empty()) {
        return refuse("Sandbox team tasks run in parallel on the same base, without dependencies");
    }
    run["runtime"] = json!(super::sandbox::TRANSPORT);
    Ok(())
}

/// One member execution per task, each with the task's frozen agent.
pub(super) fn start<S: SqlStore>(db: &S, run: &Value, now: i64) -> Result<()> {
    let agents = run["agents"]
        .as_array()
        .ok_or_else(|| bad("Missing agents"))?;
    let members = run["team_plan"]["tasks"]
        .as_array()
        .ok_or_else(|| bad("Missing team plan"))?
        .iter()
        .map(|task| {
            let mut agent = slot(task)
                .and_then(|index| agents.get(index))
                .cloned()
                .ok_or_else(|| bad("Missing frozen team agent"))?;
            agent["strategy"] = task["title"].clone();
            Ok(agent)
        })
        .collect::<Result<Vec<_>>>()?;
    super::scheduling::schedule(db, run, &json!(members), now)
}

fn slot(task: &Value) -> Option<usize> {
    task["agent"].as_u64().and_then(|n| usize::try_from(n).ok())
}

/// Names a member execution's task at schedule time and returns its agent slot (`index`
/// for every other run, where executions and agents line up).
pub(super) fn mark_member(run: &Value, index: usize, execution: &mut Value) -> usize {
    let task = &run["team_plan"]["tasks"][index];
    if !is_team(run) || !task.is_object() {
        return index;
    }
    execution["sandbox_task"] =
        json!({"id":task["id"],"title":task["title"],"instructions":task["instructions"]});
    slot(task).unwrap_or(index)
}

/// A member's landing on the team branch, as the trusted Worker observed it. Round 0 is the
/// first landing; a conflict there grants the one resume (a repeated report grants it
/// again), a conflict in round 1 grants none and the Worker fails the member.
pub(super) fn land<S: SqlStore>(db: &S, j: &mut Value, landing: &Value, now: i64) -> Result<Value> {
    let eid = string(&j["payload"]["execution"], "id")?;
    let mut e = get(db, "executions", &eid)?;
    if !e["sandbox_task"].is_object() {
        return Err(Error::new("FORBIDDEN", "Not a sandbox team member"));
    }
    let round = landing["round"]
        .as_u64()
        .filter(|round| *round <= 1)
        .ok_or_else(|| bad("A landing round is 0 or 1"))?;
    let rid = string(&e, "run_id")?;
    match string(landing, "outcome")?.as_str() {
        "conflict" => {
            let paths = conflict_paths(landing)?;
            e["landing"] = json!({"status":"conflict","paths":paths,"round":round,"resumed":true});
            save_execution(db, &e, now)?;
            event(
                db,
                "sandbox.team_conflict",
                now,
                json!({"run_id":rid,"execution_id":eid,"round":round,"paths":paths}),
            )?;
            Ok(json!({"resume": round == 0}))
        }
        "landed" => {
            let commit = hash(landing, "commit", &[40, 64])?;
            let team_commit = hash(landing, "team_commit", &[40, 64])?;
            e["landing"] = json!({"status":"landed","commit":commit,"team_commit":team_commit,
                "version":landing["version"].as_u64(),"round":round,"resumed":round == 1});
            e["status"] = json!("landed");
            e["finished_at"] = json!(now);
            save_execution(db, &e, now)?;
            let id = string(j, "id")?;
            j["status"] = json!("done");
            j["result"] = e["landing"].clone();
            j["finished_at"] = json!(now);
            save(db, "jobs", &id, j)?;
            event(db, "job.completed", now, job_event(j))?;
            settle(db, &rid, now)?;
            Ok(json!({"status":"landed"}))
        }
        _ => Err(bad("A landing outcome is landed or conflict")),
    }
}

fn conflict_paths(landing: &Value) -> Result<Vec<String>> {
    let paths = landing["paths"]
        .as_array()
        .filter(|paths| !paths.is_empty())
        .ok_or_else(|| bad("A conflict names its paths"))?;
    paths
        .iter()
        .take(CONFLICT_PATHS)
        .map(|path| {
            let path = path.as_str().ok_or_else(|| bad("Invalid conflict path"))?;
            yoneda_agents_core::validate_path(path)?;
            Ok(path.to_owned())
        })
        .collect()
}

/// A failed member settles its run; a failed team-branch capture or check fails it.
pub(super) fn failed<S: SqlStore>(db: &S, e: &Value, now: i64) -> Result<()> {
    let rid = string(e, "run_id")?;
    if e["sandbox_task"].is_object() {
        return settle(db, &rid, now);
    }
    if e["team_role"] == "team_branch" {
        fail_run(db, &rid, e["error"].clone(), now)?;
    }
    Ok(())
}

fn fail_run<S: SqlStore>(db: &S, rid: &str, error: Value, now: i64) -> Result<()> {
    let mut run = get(db, "runs", rid)?;
    if ["cancelled", "accepted", "failed"].contains(&run["status"].as_str().unwrap_or_default()) {
        return Ok(());
    }
    run["status"] = json!("failed");
    run["error"] = error;
    save(db, "runs", rid, &run)?;
    event(
        db,
        "run.failed",
        now,
        json!({"run_id":rid,"error":run["error"]}),
    )
}

/// Once every member has landed or failed: one trusted capture reads the team branch head
/// from the platform and makes it the run's candidate; when nothing landed, the run fails.
fn settle<S: SqlStore>(db: &S, rid: &str, now: i64) -> Result<()> {
    let mut run = get(db, "runs", rid)?;
    if !is_team(&run)
        || !run["team_branch"].is_null()
        || ["cancelled", "accepted", "failed"].contains(&run["status"].as_str().unwrap_or_default())
    {
        return Ok(());
    }
    let members: Vec<Value> = run_executions(db, rid)?
        .into_iter()
        .filter(|e| e["sandbox_task"].is_object())
        .collect();
    if members.iter().any(|e| {
        !matches!(
            e["status"].as_str(),
            Some("landed" | "failed" | "cancelled")
        )
    }) {
        return Ok(());
    }
    let landed: Vec<&Value> = members.iter().filter(|e| e["status"] == "landed").collect();
    if landed.is_empty() {
        return fail_run(
            db,
            rid,
            json!("No team member landed a change on the team branch"),
            now,
        );
    }
    let eid = format!("{rid}:team");
    let e = json!({"id":eid,"run_id":rid,"role":"team_branch","team_role":"team_branch",
        "strategy":"Team branch","status":"capturing","base":run["base"],"started_at":now,"depth":0});
    create(db, "executions", &eid, &e)?;
    node(
        db,
        &eid,
        "execution",
        "Team branch",
        "platform",
        now,
        e.clone(),
    )?;
    for member in &landed {
        edge(
            db,
            &string(member, "id")?,
            &eid,
            "landed_on",
            "platform merge on landing",
        )?;
    }
    let summary = format!(
        "Team branch: {} of {} tasks landed",
        landed.len(),
        members.len()
    );
    job(
        db,
        &format!("capture:{eid}"),
        "capture",
        now,
        json!({"execution":e,"run_id":rid,"base":run["base"],"capture_subtype":"sandbox_team","summary":summary}),
    )?;
    run["team_branch"] = json!({"execution":eid,"landed":landed.len(),"members":members.len()});
    save(db, "runs", rid, &run)
}

/// Only the team branch's candidate is selectable in a sandbox team run.
pub(super) fn validate_candidate<S: SqlStore>(db: &S, candidate: &Value) -> Result<()> {
    let execution = get(db, "executions", &string(candidate, "execution")?)?;
    if execution["team_role"] != "team_branch" {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the team branch is selectable",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "sandbox_team_tests.rs"]
mod tests;
