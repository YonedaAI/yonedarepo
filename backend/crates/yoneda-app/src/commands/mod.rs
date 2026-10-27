use crate::storage::{SqlStore, string};
use serde_json::Value;
use yoneda_agents_core::{Error, Result};
mod acceptance;
mod adaptive_team;
mod archive;
mod autonomy;
mod branches;
mod budget_availability;
mod campaign;
mod capture_completion;
mod capture_source;
mod comparison;
mod completion;
pub(crate) mod conflicts;
mod context_access;
mod context_evidence;
mod context_packet;
mod context_seed;
mod context_sessions;
mod context_usage;
mod continuations;
mod delegation;
mod deletion;
mod events;
mod execution_logs;
mod external;
pub(crate) mod guided;
#[cfg(test)]
mod guided_tests;
mod history;
mod leases;
mod mcp;
mod model_budgets;
mod model_reservations;
mod peer_messages;
mod peers;
mod policy;
mod publication;
mod recovery;
mod repository;
mod resources;
mod restarts;
mod run_visibility;
mod runs;
mod sandbox;
mod sandbox_team;
mod sandbox_usage;
mod scheduling;
mod sites;
mod source_capture_retry;
#[cfg(any(test, feature = "test-kit"))]
pub mod source_kit;
mod source_refresh;
mod source_transport;
mod study;
mod team;
mod transcripts;
mod typed_context;
pub(crate) fn dispatch<S: SqlStore>(db: &S, c: Value) -> Result<Value> {
    let now = c["now"].as_i64().unwrap_or_default();
    let op = string(&c, "op")?;
    guided::guard(&c)?;
    if op == "delete_repository" {
        return deletion::delete(db, &c, now);
    }
    // This field is set by the authenticated adapter, after discarding caller authority fields.
    if let Some(workspace) = c["_workspace"].as_str()
        && workspace != "_admin"
        && c["op"] != "init"
    {
        let repository = crate::storage::repo(db)?;
        if repository["workspace"].as_str().unwrap_or("_admin") != workspace {
            return Err(Error::new(
                "FORBIDDEN",
                "Repository belongs to another workspace",
            ));
        }
    }
    if let Ok(repository) = crate::storage::repo(db)
        && repository["status"] == "deleted"
    {
        match op.as_str() {
            "claim" => return Ok(serde_json::json!({"already_done":true,"deleted":true})),
            "recover" => return Ok(serde_json::json!({"recovered":0})),
            "repository_status" | "deletion_status" | "outbox" | "outbox_sent" => {}
            _ => {
                return Err(Error::new(
                    "REPOSITORY_DELETED",
                    "This repository has been deleted",
                ));
            }
        }
    }
    context_access::activation(db, now)?;
    comparison::guard_tools(db, &c)?;
    if ["context_search", "context_get"].contains(&op.as_str())
        && let Some(result) = comparison::read_context(db, &c, now)?
    {
        return Ok(result);
    }
    match string(&c, "op")?.as_str() {
        "guided_session" | "start_guided_step" => guided::handle(db, &c, now),
        "retry_capture" => source_capture_retry::handle(db, &c, now),
        "source_refresh_context" => source_refresh::context(db, &c, now),
        "source_refresh_paths" => source_refresh::paths(db, &c, now),
        "source_read_context"
        | "source_bind"
        | "source_register_changeset"
        | "source_registered"
        | "source_resume_grant"
        | "source_capture_context" => crate::source_binding::handle(db, &c, now),
        "approve_comparison_review"
        | "select_comparison_candidate"
        | "comparison_context"
        | "comparison_submit"
        | "comparison_approval" => comparison::handle(db, &c, now),
        "run_set_visibility" | "project_visibility_check" => run_visibility::handle(db, &c, now),
        "observe_campaign_model_limit" => budget_availability::observe(db, &c, now),
        "candidate_paths" => crate::path_lists::page(db, &c),
        "repository_status" => {
            let mut r = crate::storage::repo(db)?;
            r["capabilities"] = repository::capabilities(db, now)?;
            Ok(r)
        }
        "resync_repository" | "defer_job" => recovery::handle(db, &c, now),
        "conflict_status"
        | "conflict_paths"
        | "refresh_candidate"
        | "resolve_conflict"
        | "conflict_refresh_complete" => conflicts::handle(db, &c, now),
        "deletion_status" => deletion::status(db),
        "external_begin" | "external_check" | "external_status" | "external_freeze"
        | "external_bind" | "external_submit" => external::handle(db, c, now),
        "peer_status" => peers::read(db, &c, now),
        "peer_messages_page" => peer_messages::page(db, &c),
        "peer_message" | "peer_inbox" => peer_messages::handle(db, &c, now),
        "intent_question" | "answer_intent" => autonomy::question(db, &c, now),
        "create_working_branch" | "working_branch" | "working_branches" => {
            branches::handle(db, &c, now)
        }
        "update_policy" => policy::update(db, c, now),
        "configure_context_study" => study::configure(db, c, now),
        "init"
        | "snapshot"
        | "repository_overview"
        | "runs_page"
        | "run_detail"
        | "run_graph_page"
        | "candidate_record"
        | "evaluation_record"
        | "job_status" => repository::handle(db, c, now),
        "archive_candidates"
        | "archive_prepare"
        | "archive_commit"
        | "archive_status"
        | "schedule_archive_due" => archive::handle(db, c, now),
        "start_run" | "cancel_run" => runs::handle(db, c, now),
        "delegate_agent" | "delegation_status" => delegation::handle(db, c, now),
        "team_context"
        | "team_plan_propose"
        | "task_handoff"
        | "integration_request"
        | "retry_team_task"
        | "repair_request"
        | "retry_coordinator"
        | "repair_team" => team::handle(db, c, now),
        "context_publish" | "context_search" | "context_get" => typed_context::handle(db, c, now),
        "record_context_access" => context_access::record(db, c, now),
        "context_usage" => context_usage::read(db, c, now),
        "context_session_begin" | "context_session_get" | "context_session_end" => {
            context_sessions::handle(db, c, now)
        }
        "claim" | "check_attempt" | "heartbeat" | "progress" | "fail" | "recover" => {
            leases::handle(db, c, now)
        }
        "context" | "publish_artifact" | "authorize_artifact" | "get_artifact"
        | "hint_complete" => mcp::handle(db, c, now),
        "outbox" | "outbox_sent" | "outbox_prune" | "events" => events::handle(db, c, now),
        "why" | "graph" | "observe" | "decision" => history::handle(db, c, now),
        "finish" | "verify_finish" => completion::handle(db, c, now),
        "sandbox_progress" | "sandbox_finish" | "sandbox_land" => sandbox::handle(db, c, now),
        "sandbox_budget" => sandbox_usage::budget(db, &c, now),
        "sandbox_usage" => sandbox_usage::record(db, &c, now),
        "accept" => acceptance::handle(db, c, now),
        "reject_candidate" | "publication_readback" => publication::handle(db, &c, now),
        "register_site" => sites::register(db, c, now),
        "record_transcript" => transcripts::record(db, c, now),
        "record_execution_log" => execution_logs::record(db, c, now),
        "execution_logs" => execution_logs::read(db, c),
        "reserve_request" => resources::reserve(db, c),
        "settle_model_request" => model_reservations::settle(db, c, now),
        _ => Err(Error::new("NOT_FOUND", "Unknown repository operation")),
    }
}
