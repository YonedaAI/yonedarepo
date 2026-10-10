//! Native isolated execution and MCP transport.
use serde_json::Value;
use yoneda_core::Error;
mod agent;
mod agent_transcript;
mod broker;
mod evaluation;
mod execution_limits;
mod git;
mod harness_error;
mod jobs;
mod mcp;
mod process;
mod process_guard;
mod prompt;
mod report;
mod secure_fs;
mod site;
mod source_filter;
mod supervisor;
mod supervisor_task;
mod team_planning;
mod team_prompt;
mod team_source;
mod team_workspace;
mod telemetry;
mod workspace;
pub use git::{capture, git};
pub use mcp::mcp;
pub use supervisor::serve;
pub use telemetry::init_telemetry;
pub use workspace::{export_workspace, materialize};
fn err(e: impl std::fmt::Display) -> Error {
    Error::new("RUNTIME", e.to_string())
}
fn field<'a>(v: &'a Value, k: &str) -> yoneda_core::Result<&'a str> {
    v[k].as_str().ok_or_else(|| err(format!("Missing {k}")))
}
#[cfg(test)]
mod tests;
