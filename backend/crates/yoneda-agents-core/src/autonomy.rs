//! Approval envelope for agent-directed work; it grants no publication capability.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutonomyPolicy {
    pub version: u32,
    pub enabled: bool,
    #[serde(default = "rounds")]
    pub max_repair_rounds: u32,
    #[serde(default = "concurrency")]
    pub max_concurrent_agents: u32,
    #[serde(default = "executions")]
    pub max_executions: u32,
    #[serde(default = "scope")]
    pub source_scope: String,
    #[serde(default = "questions")]
    pub allow_intent_questions: bool,
}
fn rounds() -> u32 {
    2
}
fn concurrency() -> u32 {
    3
}
fn executions() -> u32 {
    20
}
fn scope() -> String {
    "project".into()
}
fn questions() -> bool {
    true
}
impl AutonomyPolicy {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.source_scope != "project"
            || !(1..=2).contains(&self.max_repair_rounds)
            || !(1..=6).contains(&self.max_concurrent_agents)
            || !(1..=20).contains(&self.max_executions)
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Autonomy needs version 1, project scope, bounded concurrency, executions and repair rounds",
            ));
        }
        Ok(())
    }
}
