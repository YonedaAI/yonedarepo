//! Bounded hosted agent scheduling and delegation contracts.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const MIN_ROOT_AGENTS: usize = 1;
pub const MAX_ROOT_AGENTS: usize = 6;
pub const MAX_RUN_EXECUTIONS: usize = 12;
pub const MAX_DELEGATION_DEPTH: u8 = 2;
pub const MAX_RUN_MODEL_REQUESTS: i64 = 144;

/// Limits are frozen when the owner starts a run. Children cannot expand them.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DelegationPolicy {
    pub enabled: bool,
    pub max_depth: u8,
    pub max_executions: usize,
}
impl DelegationPolicy {
    pub fn disabled(root_count: usize) -> Self {
        Self {
            enabled: false,
            max_depth: 0,
            max_executions: root_count,
        }
    }
    pub fn validate(&self, root_count: usize) -> Result<()> {
        if self.max_executions < root_count
            || self.max_executions > MAX_RUN_EXECUTIONS
            || self.max_depth > MAX_DELEGATION_DEPTH
            || (!self.enabled && self.max_depth != 0)
            || (self.enabled && self.max_depth == 0)
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Delegation requires a bounded execution budget and enabled depth of 1–2; disabled depth is zero",
            ));
        }
        Ok(())
    }
}

/// A request ID is unique within the parent's execution, including its retries.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DelegationRequest {
    pub request_id: String,
    pub task: String,
    pub strategy: String,
}
impl DelegationRequest {
    pub fn validate(&self) -> Result<()> {
        if self.request_id.is_empty()
            || self.request_id.len() > 80
            || !self
                .request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            || self.task.trim().is_empty()
            || self.task.len() > 8192
            || self.task.contains('\0')
            || self.strategy.trim().is_empty()
            || self.strategy.len() > 128
            || self.strategy.contains('\0')
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Delegation needs a safe request ID, a task of at most 8192 bytes and a strategy of at most 128 bytes",
            ));
        }
        Ok(())
    }
}
