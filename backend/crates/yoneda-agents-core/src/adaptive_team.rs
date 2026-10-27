//! A frozen connected-model pool authorizes roster selection, not new model approvals.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

pub const MAX_ADAPTIVE_AGENTS: usize = 6;
pub const MAX_POOL_CONNECTIONS: usize = 32;
pub const MAX_ADAPTIVE_MODEL_REQUESTS: i64 = 144;
mod fixed_effort;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    On,
    Off,
}
impl ReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
            Self::On => "on",
            Self::Off => "off",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RequestedAgent {
    pub connection: Option<String>,
    pub role: AgentRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AdaptiveTeam {
    pub version: u32,
    pub requested_agents: Vec<RequestedAgent>,
    /// Owner-approved pool connection for slots that own specialist tasks. Integration,
    /// coordination and planning keep their planned connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub specialist_connection: Option<String>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasoning_efforts: Vec<ReasoningEffort>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentSelection {
    pub connection: String,
    pub role: AgentRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
}

impl AdaptiveTeam {
    pub fn validate(&self, pool: &[ApprovedModel]) -> Result<()> {
        if self.version != 1 || !(1..=MAX_ADAPTIVE_AGENTS).contains(&self.requested_agents.len()) {
            return Err(invalid("Request 1–6 agents with adaptive version 1"));
        }
        validate_pool(pool)?;
        if let Some(connection) = &self.specialist_connection {
            bounded(connection, 120)?;
            if !pool.iter().any(|m| &m.connection == connection) {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Specialist connection is outside the frozen pool",
                ));
            }
        }
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
            if let Some(effort) = request.reasoning_effort
                && !pool.iter().any(|m| {
                    request
                        .connection
                        .as_ref()
                        .is_none_or(|c| c == &m.connection)
                        && m.reasoning_efforts.contains(&effort)
                })
            {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Requested reasoning effort is unavailable for the approved connection",
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
        let mut efforts = BTreeSet::new();
        for effort in &member.reasoning_efforts {
            if !efforts.insert(effort.as_str()) {
                return Err(invalid("Duplicate model reasoning effort"));
            }
            validate_effort(&member.provider, &member.model, effort.as_str())?;
        }
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

pub fn validate_effort(provider: &str, model: &str, effort: &str) -> Result<()> {
    if !crate::providers::provider(provider)?
        .models
        .iter()
        .any(|m| m.id == model && m.reasoning_efforts.iter().any(|e| e == effort))
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Reasoning effort is not supported by this exact model",
        ));
    }
    Ok(())
}

/// Exact adaptive slot settings are authority; omitted effort preserves legacy defaults.
pub fn execution_effort<'a>(run: &Value, execution: &'a Value) -> Result<Option<&'a str>> {
    if !execution["comparison_approval_id"].is_null() || !execution["comparison_role"].is_null() {
        crate::comparison::validate_execution(run, execution)?;
        return Ok(execution["reasoning_effort"].as_str());
    }
    let effort = match execution.get("reasoning_effort").filter(|v| !v.is_null()) {
        Some(value) => Some(
            value
                .as_str()
                .ok_or_else(|| invalid("Invalid execution reasoning effort"))?,
        ),
        None => None,
    };
    if run["adaptive_team"].is_object() {
        if execution["agent_index"].is_null()
            && effort.is_none()
            && run["agents"]
                .as_array()
                .is_some_and(|agents| agents.iter().all(|a| a["reasoning_effort"].is_null()))
        {
            return Ok(None);
        }
        let index = execution["agent_index"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| Error::new("FENCED", "Adaptive execution has no approved agent slot"))?;
        let agent = run["agents"]
            .as_array()
            .and_then(|a| a.get(index))
            .ok_or_else(|| Error::new("FENCED", "Adaptive execution slot changed"))?;
        if ["connection", "provider", "model", "reasoning_effort"]
            .iter()
            .any(|field| execution[field] != agent[field])
        {
            return Err(Error::new(
                "FENCED",
                "Execution reasoning or model differs from its approved roster slot",
            ));
        }
    } else {
        fixed_effort::validate(run, execution, effort)?;
    }
    if let Some(effort) = effort {
        validate_effort(
            execution["provider"]
                .as_str()
                .ok_or_else(|| invalid("Missing execution provider"))?,
            execution["model"]
                .as_str()
                .ok_or_else(|| invalid("Missing execution model"))?,
            effort,
        )?;
    }
    Ok(effort)
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

#[cfg(test)]
#[path = "adaptive_team/reasoning_tests.rs"]
mod reasoning_tests;

#[cfg(test)]
#[path = "adaptive_team/specialist_tests.rs"]
mod specialist_tests;
