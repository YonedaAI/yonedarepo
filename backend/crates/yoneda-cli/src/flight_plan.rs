//! `yoneda flight-plan`: files the goal of this work before it starts, so the landing shows
//! what it set out to do. The client says which branch it is for (default: the clone's
//! current one, pushed or not). It is written on purpose, by this command or MCP
//! `git_flight_plan`; no hook reads it out of a prompt, because prompts are not kept.
use crate::error::Result;
use crate::human;
use crate::output;
use crate::repo_ops::current_branch;
use crate::session_files::current_session;
use crate::target::Resolved;
use serde_json::json;

/// What `yoneda flight-plan` was asked to file.
pub struct Plan {
    pub goal: String,
    pub scope: Option<String>,
    pub branch: Option<String>,
    pub change: Option<u64>,
    pub session_id: Option<String>,
}

pub async fn run(t: &Resolved, plan: Plan) -> Result<()> {
    let branch = plan.branch.or_else(|| current_branch(t));
    let body = json!({
        "goal": plan.goal, "scope": plan.scope, "branch": branch, "change": plan.change,
        "session_id": plan.session_id.or_else(current_session),
    });
    let filed = t.api.post("/flight-plans", &body).await?;
    let plan = filed["plan"].clone();
    match plan["branch"].as_str() {
        Some(branch) => human!("Flight plan #{} filed for {branch}", plan["id"]),
        None => human!("Flight plan #{} filed for this session", plan["id"]),
    }
    output::emit(&output::FlightPlan { plan });
    Ok(())
}
