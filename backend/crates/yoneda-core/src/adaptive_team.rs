//! A frozen connected-model pool authorizes roster selection, not new model approvals.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

pub const MAX_ADAPTIVE_AGENTS: usize = 6;
pub const MAX_POOL_CONNECTIONS: usize = 32;
pub const MAX_ADAPTIVE_MODEL_REQUESTS: i64 = 144;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentRole {
    Auto,
    Builder,
    Frontend,
    Backend,
    Design,
    Testing,
    Review,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RequestedAgent {
    pub connection: Option<String>,
    pub role: AgentRole,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AdaptiveTeam {
    pub version: u32,
    pub requested_agents: Vec<RequestedAgent>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApprovedModel {
    pub connection: String,
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentSelection {
    pub connection: String,
    pub role: AgentRole,
}

impl AdaptiveTeam {
    pub fn validate(&self, pool: &[ApprovedModel]) -> Result<()> {
        if self.version != 1 || !(1..=MAX_ADAPTIVE_AGENTS).contains(&self.requested_agents.len()) {
            return Err(invalid("Request 1–6 agents with adaptive version 1"));
        }
        validate_pool(pool)?;
        for request in &self.requested_agents {
            if let Some(connection) = &request.connection {
                bounded(connection, 120)?;
                if !pool.iter().any(|m| &m.connection == connection) {
                    return Err(Error::new(
                        "FORBIDDEN",
                        "Requested connection is outside the frozen pool",
                    ));
                }
            }
        }
        Ok(())
    }
    pub fn validate_selection(
        &self,
        pool: &[ApprovedModel],
        agents: &[AgentSelection],
    ) -> Result<()> {
        self.validate(pool)?;
        if agents.len() < self.requested_agents.len() || agents.len() > MAX_ADAPTIVE_AGENTS {
            return Err(invalid(
                "The planned roster must retain every requested agent within six slots",
            ));
        }
        for (index, agent) in agents.iter().enumerate() {
            if !pool.iter().any(|m| m.connection == agent.connection) {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Planned connection is outside the frozen pool",
                ));
            }
            if let Some(request) = self.requested_agents.get(index)
                && (request
                    .connection
                    .as_ref()
                    .is_some_and(|c| c != &agent.connection)
                    || request.role != AgentRole::Auto && request.role != agent.role)
            {
                return Err(Error::new(
                    "FORBIDDEN",
                    "The plan changed an explicitly requested model or role",
                ));
            }
        }
        Ok(())
    }
}
pub fn validate_pool(pool: &[ApprovedModel]) -> Result<()> {
    if !(1..=MAX_POOL_CONNECTIONS).contains(&pool.len()) {
        return Err(invalid("A bounded connected-model pool is required"));
    }
    let mut connections = BTreeSet::new();
    for member in pool {
        bounded(&member.connection, 120)?;
        bounded(&member.provider, 128)?;
        bounded(&member.model, 128)?;
        crate::providers::provider(&member.provider)?;
        if !connections.insert(&member.connection)
            || member.version.is_some_and(|v| v < 0)
            || member
                .routing
                .as_ref()
                .is_some_and(|v| v.to_string().len() > 4096)
        {
            return Err(invalid("Invalid or duplicate approved connection"));
        }
    }
    Ok(())
}
fn bounded(value: &str, limit: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        return Err(invalid("Invalid bounded pool identity"));
    }
    Ok(())
}
fn invalid(message: &str) -> Error {
    Error::new("INVALID_INPUT", message)
}
