//! Frozen hosted team contracts. A task scope is exact or a directory prefix ending in `/`.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_TEAM_TASKS: usize = 16;
/// Leaves room for bounded owner-approved resolver executions alongside the frozen DAG.
pub const MAX_TEAM_EXECUTIONS: usize = MAX_TEAM_TASKS + 4;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TeamPlan {
    pub version: u32,
    pub contract: String,
    pub integrator_agent: usize,
    pub integration_paths: Vec<String>,
    pub tasks: Vec<TeamTask>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TeamTask {
    pub id: String,
    pub title: String,
    pub instructions: String,
    pub agent: usize,
    pub depends_on: Vec<String>,
    pub write_paths: Vec<String>,
}
impl TeamPlan {
    pub fn validate(&self, agents: usize) -> Result<()> {
        if self.version != 1
            || !(1..=crate::agents::MAX_ROOT_AGENTS).contains(&agents)
            || self.integrator_agent >= agents
            || !(1..=MAX_TEAM_TASKS).contains(&self.tasks.len())
        {
            return Err(invalid(
                "A team needs 1–16 tasks and a designated integrator from its 1–6 configured agents",
            ));
        }
        bounded(&self.contract, 16384, "team contract")?;
        validate_scopes(&self.integration_paths)?;
        let mut ids = BTreeSet::new();
        let mut assigned = BTreeSet::from([self.integrator_agent]);
        for task in &self.tasks {
            if task.id.is_empty()
                || task.id.len() > 64
                || task.id == "integrate"
                || !task
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                || !ids.insert(task.id.clone())
                || task.agent >= agents
            {
                return Err(invalid(
                    "Task IDs must be unique and safe, with assignments from the configured roster",
                ));
            }
            bounded(&task.title, 128, "task title")?;
            bounded(&task.instructions, 8192, "task instructions")?;
            validate_scopes(&task.write_paths)?;
            assigned.insert(task.agent);
            let dependencies: BTreeSet<_> = task.depends_on.iter().collect();
            if dependencies.len() != task.depends_on.len() || task.depends_on.len() > MAX_TEAM_TASKS
            {
                return Err(invalid("Task dependencies must be unique and bounded"));
            }
        }
        if assigned.len() != agents {
            return Err(invalid(
                "Every configured team agent must own a specialist task or integration",
            ));
        }
        for (index, task) in self.tasks.iter().enumerate() {
            if task
                .depends_on
                .iter()
                .any(|id| !ids.contains(id) || id == &task.id)
            {
                return Err(invalid(
                    "Task dependencies must name other tasks in this plan",
                ));
            }
            for other in self.tasks.iter().skip(index + 1) {
                if task
                    .write_paths
                    .iter()
                    .any(|a| other.write_paths.iter().any(|b| scopes_overlap(a, b)))
                {
                    return Err(invalid(
                        "Specialist write scopes must be disjoint; shared files need one designated owner",
                    ));
                }
            }
        }
        self.order()?;
        Ok(())
    }
    /// Stable topological order: dependencies first, ties sorted by task ID.
    pub fn order(&self) -> Result<Vec<String>> {
        let tasks: BTreeMap<_, _> = self.tasks.iter().map(|t| (t.id.clone(), t)).collect();
        let mut complete = BTreeSet::new();
        let mut result = Vec::new();
        while result.len() < tasks.len() {
            let next = tasks.iter().find(|(id, t)| {
                !complete.contains(*id) && t.depends_on.iter().all(|d| complete.contains(d))
            });
            let Some((id, _)) = next else {
                return Err(invalid("Team task dependencies must be acyclic"));
            };
            complete.insert(id.clone());
            result.push(id.clone());
        }
        Ok(result)
    }
}
/// Validate bounded scopes, including the path safety rules used by trusted capture.
pub fn validate_scopes(paths: &[String]) -> Result<()> {
    if paths.is_empty() || paths.len() > 32 {
        return Err(invalid("Choose 1–32 explicit source write scopes"));
    }
    let mut unique = BTreeSet::new();
    for path in paths {
        crate::validate_path(path.strip_suffix('/').unwrap_or(path))?;
        if !unique.insert(path) {
            return Err(invalid("Write scopes must be unique"));
        }
    }
    Ok(())
}
pub fn owns_path(scope: &str, path: &str) -> bool {
    scope == path || (scope.ends_with('/') && path.starts_with(scope))
}
fn scopes_overlap(a: &str, b: &str) -> bool {
    let a = a.trim_end_matches('/');
    let b = b.trim_end_matches('/');
    a == b
        || b.strip_prefix(a).is_some_and(|s| s.starts_with('/'))
        || a.strip_prefix(b).is_some_and(|s| s.starts_with('/'))
}
fn bounded(s: &str, max: usize, label: &str) -> Result<()> {
    if s.trim().is_empty() || s.len() > max || s.contains('\0') {
        return Err(invalid(&format!("Invalid bounded {label}")));
    }
    Ok(())
}
fn invalid(s: &str) -> Error {
    Error::new("INVALID_INPUT", s)
}
