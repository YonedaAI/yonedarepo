//! `sandbox-cli-v1`: each agent of a compare run (one to six) runs an unmodified coding CLI
//! (Claude Code, Codex CLI, opencode or MiMo Code: the agent's frozen `cli`) in its own
//! Cloudflare Sandbox, driven by the Worker's `AgentSandbox` Durable
//! Object, and pushes to its own `attempts/<run>/<n>` branch. The ledger keeps only:
//! - the claim, with one long lease that is a safety backstop, never a heartbeat;
//! - the latest observed activity, for "last activity" and the idle marker;
//! - the pushed commit, which becomes the candidate directly (no capture job), with the same
//!   checks as a contribution capture: one commit on the frozen base in the project's repository.
//!
//! Failure uses the ordinary `fail` operation, cancellation the ordinary `cancel_run`.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::agents::DelegationPolicy;
use yoneda_agents_core::{Error, Result};

pub(crate) const TRANSPORT: &str = "sandbox-cli-v1";
/// The Durable Object stops the CLI after two hours and then commits and pushes what exists;
/// the lease outlives that so finalization can finish before recovery fails the attempt.
const LEASE_MS: i64 = 2 * 3_600_000 + 15 * 60_000;
const SUMMARY_LIMIT: usize = 200;

/// Whether a run (or job payload) transport works on platform source: lazy API source, or a
/// sandbox run. Sandbox runs started before their own tag carry `api-source-v1` and `runtime`.
pub(crate) fn platform_source(transport: &Value) -> bool {
    transport == "api-source-v1" || transport == TRANSPORT
}

/// Whether `start_run` asks for a sandbox attempt (set only by the authenticated adapter).
pub(super) fn requested(c: &Value) -> bool {
    c["workspace_transport"] == TRANSPORT
}

/// Independent coding attempts only: a compare run's agents (the roster is already validated
/// as one to six), each with its own sandbox and candidate, chosen by the owner. Team runs,
/// delegation and the comparison reviewer are not sandbox work.
pub(super) fn freeze(
    c: &Value,
    general: bool,
    team: bool,
    delegation: &DelegationPolicy,
    run: &mut Value,
) -> Result<()> {
    if !general || team || c["mode"] == "collaborate" || !c["comparison"].is_null() {
        return Err(Error::new(
            "NOT_SUPPORTED",
            "Sandbox runs take independent coding agents, without team or comparison review",
        ));
    }
    if delegation.enabled {
        return Err(Error::new("NOT_SUPPORTED", "Sandbox runs do not delegate"));
    }
    freeze_clis(run)?;
    run["runtime"] = json!(TRANSPORT);
    Ok(())
}

/// The stock CLIs that can drive each provider harness's API, the default first. Claude Code
/// speaks Anthropic Messages only and Codex CLI the OpenAI Responses API only; opencode and
/// its fork MiMo Code carry all three. Mirrors `sandboxClis` in `shared/providers.ts`.
fn clis(harness: &str) -> &'static [&'static str] {
    match harness {
        "claude" => &["claude", "opencode", "mimo"],
        "codex" => &["codex", "opencode", "mimo"],
        "gemini" => &["opencode", "mimo"],
        _ => &[],
    }
}

/// Freezes each agent's CLI: the owner's choice when it can drive the agent's provider, the
/// provider's default when none was chosen. An impossible pair is refused before any start.
pub(super) fn freeze_clis(run: &mut Value) -> Result<()> {
    let agents = run["agents"]
        .as_array_mut()
        .ok_or_else(|| bad("Missing agents"))?;
    for agent in agents {
        let provider = string(agent, "provider")?;
        let fits = clis(&yoneda_agents_core::providers::provider(&provider)?.harness);
        let cli = match agent.get("cli").filter(|v| !v.is_null()) {
            None => *fits
                .first()
                .ok_or_else(|| harness(&format!("No sandbox CLI runs {provider} models")))?,
            Some(value) => {
                let cli = value.as_str().unwrap_or_default();
                if !["claude", "codex", "opencode", "mimo"].contains(&cli) {
                    return Err(bad(
                        "The sandbox CLI is one of claude, codex, opencode or mimo",
                    ));
                }
                *fits
                    .iter()
                    .find(|fit| **fit == cli)
                    .ok_or_else(|| harness(&format!("{cli} cannot run {provider} models")))?
            }
        };
        agent["cli"] = json!(cli);
    }
    Ok(())
}

fn harness(message: &str) -> Error {
    Error::new("SANDBOX_HARNESS", message)
}

/// Marks a sandbox execution at schedule time with its frozen agent's (`slot`) CLI.
pub(super) fn mark_execution(run: &Value, slot: usize, execution: &mut Value) {
    if run["runtime"] == TRANSPORT {
        execution["runtime"] = json!(TRANSPORT);
        execution["cli"] = run["agents"][slot]["cli"].clone();
    }
}

/// A claimed sandbox job holds one lease for the whole attempt and is never re-dispatched:
/// `attempt` 2 makes lease expiry a failure in `recover`, not a second launch.
pub(super) fn claimed(job: &mut Value, now: i64) {
    if job["payload"]["execution"]["runtime"] != TRANSPORT {
        return;
    }
    job["sandbox"] = json!(true);
    job["attempt"] = json!(2);
    job["lease_until"] = json!(now + LEASE_MS);
    job["attempt_deadline"] = json!(now + LEASE_MS);
}

/// A sandbox run's candidate is checked in a fresh check sandbox (same image, its own
/// instance, read-only repository access) on a real disk, not the evaluator container. The
/// Durable Object records a failure at this overall cap; the lease outlives it.
const CHECK_CAP_MS: i64 = 15 * 60_000;
const CHECK_LEASE_MS: i64 = CHECK_CAP_MS + 5 * 60_000;

/// Marks a claimed evaluation of a sandbox run's candidate as one check-sandbox attempt,
/// never re-dispatched: the report still arrives through `verify_finish` with the same
/// validation. Checks the sandbox does not run (guided steps, immutable test bundles and app
/// bundles) stay with the evaluator container.
pub(super) fn claimed_check<S: SqlStore>(db: &S, job: &mut Value, now: i64) -> Result<()> {
    let payload = &job["payload"];
    let build = &payload["policy"]["build"];
    let checkable = job["kind"] == "evaluate"
        && payload["guided"].is_null()
        && build.is_object()
        && build["app"].is_null()
        && build["test_bundle"].is_null();
    let Some(run_id) = payload["run_id"].as_str().filter(|_| checkable) else {
        return Ok(());
    };
    if get(db, "runs", run_id)?["runtime"] != TRANSPORT {
        return Ok(());
    }
    job["sandbox_check"] = json!(true);
    job["attempt"] = json!(2);
    job["lease_until"] = json!(now + CHECK_LEASE_MS);
    job["attempt_deadline"] = json!(now + CHECK_LEASE_MS);
    job["attempt_ceiling_at"] = json!(now + CHECK_LEASE_MS);
    Ok(())
}

pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let mut j = active(db, &c, now)?;
    if j["sandbox"] != true {
        return Err(Error::new("FORBIDDEN", "Not a sandbox attempt"));
    }
    match string(&c, "op")?.as_str() {
        "sandbox_progress" => progress(db, &mut j, &c["activity"], now),
        // A team member's commit lands on the team branch; the team gets one candidate.
        "sandbox_finish" if super::sandbox_team::member(&j) => Err(Error::new(
            "FORBIDDEN",
            "Team members land on the team branch",
        )),
        "sandbox_finish" => finish(db, &mut j, &c["result"], now),
        "sandbox_land" => super::sandbox_team::land(db, &mut j, &c["landing"], now),
        _ => Err(Error::new("NOT_FOUND", "Unknown sandbox operation")),
    }
}

/// Observed activity: what the CLI last did and when. It never changes the lease.
fn progress<S: SqlStore>(db: &S, j: &mut Value, activity: &Value, now: i64) -> Result<Value> {
    let phase = string(activity, "phase")?;
    if ![
        "starting",
        "cloning",
        "running",
        "finalizing",
        "landing",
        "resolving",
        "recording",
    ]
    .contains(&phase.as_str())
    {
        return Err(bad("Unknown sandbox phase"));
    }
    let at = activity["last_activity_at"]
        .as_i64()
        .filter(|at| *at > 0 && *at <= now)
        .ok_or_else(|| bad("last_activity_at must be a past timestamp"))?;
    let summary: String = activity["summary"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(SUMMARY_LIMIT)
        .collect();
    let idle_ms = activity["idle_ms"].as_i64().unwrap_or(0).max(0);
    let recorded = json!({"stage":"sandbox","phase":phase,"last_activity_at":at,"summary":summary,"idle_ms":idle_ms});
    let eid = string(&j["payload"]["execution"], "id")?;
    let mut e = get(db, "executions", &eid)?;
    let changed = e["activity"]["phase"] != recorded["phase"]
        || e["activity"]["summary"] != recorded["summary"]
        || (e["activity"]["idle_ms"].as_i64().unwrap_or(0) >= 600_000) != (idle_ms >= 600_000);
    e["activity"] = recorded.clone();
    save_execution(db, &e, now)?;
    j["progress"] = recorded.clone();
    save(db, "jobs", &string(j, "id")?, j)?;
    if changed {
        let mut data = job_event(j);
        data["progress"] = recorded;
        event(db, "job.progress", now, data)?;
    }
    Ok(json!({"recorded":true}))
}

/// The pushed commit is the candidate; evaluation then runs on that exact commit.
fn finish<S: SqlStore>(db: &S, j: &mut Value, result: &Value, now: i64) -> Result<Value> {
    let id = string(j, "id")?;
    let eid = string(&j["payload"]["execution"], "id")?;
    let mut e = get(db, "executions", &eid)?;
    let run_id = string(&e, "run_id")?;
    // The trusted capture step, done inline: the same candidate and provenance checks run on
    // this attempt's own identity, and the execution moves on to evaluation.
    e["status"] = json!("capturing");
    e["finished_at"] = json!(now);
    save_execution(db, &e, now)?;
    let capture = json!({"id":id,"kind":"capture","epoch":j["epoch"],"payload":{"execution":e,"run_id":run_id,"base":e["base"],"capture_subtype":"platform_commit"}});
    super::capture_completion::complete(db, &capture, result, now)?;
    j["status"] = json!("done");
    j["result"] = result.clone();
    j["finished_at"] = json!(now);
    save(db, "jobs", &id, j)?;
    event(db, "job.completed", now, job_event(j))?;
    Ok(json!({"status":"completed","id":id,"candidate":result["id"]}))
}

#[cfg(test)]
#[path = "sandbox_tests.rs"]
mod tests;
