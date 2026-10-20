//! Native isolated execution and MCP transport.
use serde_json::Value;
use yoneda_agents_core::Error;
mod agent;
mod agent_harness;
mod agent_transcript;
pub mod app_bundle;
mod attempt_failure;
mod broker;
pub mod check_runner;
#[cfg(all(test, unix))]
mod check_runner_tests;
mod check_server;
mod child_privileges;
mod comparison_review;
mod evaluation;
mod execution_limits;
mod git;
mod harness_error;
mod jobs;
mod mcp;
#[cfg(all(test, unix))]
mod merge_interop_tests;
mod process;
mod process_guard;
mod process_privileges;
mod prompt;
#[cfg(all(test, unix))]
mod push_batch_interop_tests;
mod report;
mod secure_fs;
mod site;
mod source_capture;
mod source_capture_api;
mod source_capture_blobs;
mod source_capture_context;
mod source_capture_diff;
mod source_capture_files;
mod source_capture_manifest;
mod source_capture_plan;
mod source_capture_runner;
mod source_capture_trees;
pub mod source_client;
pub mod source_client_api;
mod source_filter;
#[cfg(target_os = "linux")]
pub mod source_fs;
mod source_git;
#[cfg(test)]
mod source_git_fixture;
mod source_git_rewrite;
mod source_git_tree;
mod source_mcp;
pub mod source_workspace;
mod source_workspace_agent;
pub mod source_workspace_directories;
#[cfg(all(test, target_os = "linux"))]
mod source_workspace_entry_tests;
pub mod source_workspace_eval;
mod source_workspace_integrity;
pub mod source_workspace_job;
pub mod source_workspace_registry;
mod source_workspace_review;
mod source_workspace_run;
#[cfg(target_os = "linux")]
pub mod source_workspace_scratch;
#[cfg(target_os = "linux")]
pub mod source_workspace_session;
mod supervisor;
mod supervisor_task;
mod team_planning;
mod team_prompt;
mod telemetry;
mod test_bundle;
mod transport;
mod workspace;
pub use check_server::serve_checks;
pub use git::{capture, git};
pub use mcp::mcp;
pub use supervisor::serve;
pub use telemetry::init_telemetry;
pub use workspace::{export_workspace, materialize};
fn err(e: impl std::fmt::Display) -> Error {
    Error::new("RUNTIME", e.to_string())
}
fn field<'a>(v: &'a Value, k: &str) -> yoneda_agents_core::Result<&'a str> {
    v[k].as_str().ok_or_else(|| err(format!("Missing {k}")))
}
#[cfg(test)]
mod tests;

#[cfg(test)]
mod git_object_interop_tests;
#[cfg(test)]
mod source_capture_diff_tests;
#[cfg(test)]
mod source_capture_manifest_tests;
#[cfg(test)]
mod source_capture_tests;
#[cfg(test)]
mod source_git_rewrite_tests;
#[cfg(test)]
mod source_git_tests;
#[cfg(test)]
mod source_git_tree_tests;

#[cfg(test)]
mod source_capture_fixture;
#[cfg(test)]
mod source_capture_http_fixture;
#[cfg(test)]
mod source_capture_http_tests;
