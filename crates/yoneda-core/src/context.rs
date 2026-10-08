//! Agent-selected semantics; authority and identity are assigned by the platform.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ContextKind {
    Intent,
    Requirement,
    Constraint,
    Assumption,
    Finding,
    Alternative,
    ProposedDecision,
    Question,
}
impl ContextKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Intent => "intent",
            Self::Requirement => "requirement",
            Self::Constraint => "constraint",
            Self::Assumption => "assumption",
            Self::Finding => "finding",
            Self::Alternative => "alternative",
            Self::ProposedDecision => "proposed_decision",
            Self::Question => "question",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ContextRelation {
    Supports,
    Challenges,
    DependsOn,
    Supersedes,
    Answers,
    Motivates,
}
impl ContextRelation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Supports => "supports",
            Self::Challenges => "challenges",
            Self::DependsOn => "depends_on",
            Self::Supersedes => "supersedes",
            Self::Answers => "answers",
            Self::Motivates => "motivates",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ContextLink {
    pub relation: ContextRelation,
    pub target: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ContextInput {
    pub id: String,
    pub kind: ContextKind,
    pub statement: String,
    pub purpose: String,
    pub intent_id: String,
    #[serde(default)]
    pub links: Vec<ContextLink>,
}
impl ContextInput {
    pub fn validate(&self) -> Result<()> {
        for (text, limit) in [
            (&self.id, 256),
            (&self.statement, 8192),
            (&self.purpose, 2048),
            (&self.intent_id, 256),
        ] {
            if text.trim().is_empty() || text.len() > limit || text.contains('\0') {
                return Err(Error::new(
                    "INVALID_INPUT",
                    "Context requires bounded IDs, statement and purpose",
                ));
            }
        }
        if !self.id.starts_with("context:")
            && !self.id.starts_with("assumption:")
            && !self.id.starts_with("finding:")
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Use a context:, assumption: or finding: ID",
            ));
        }
        if self.links.len() > 32
            || self
                .links
                .iter()
                .any(|l| l.target.is_empty() || l.target.len() > 256 || l.target == self.id)
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Context has invalid or excessive references",
            ));
        }
        Ok(())
    }
}
