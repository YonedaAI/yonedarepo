//! Deterministic assembly from immutable captures; model output cannot select inputs or scopes.
use crate::field;
use serde_json::Value;
use std::collections::BTreeSet;
use yoneda_core::{Error, Result, Workspace, validate_path, validate_workspace};

pub(crate) struct Assembly<'a> {
    base: &'a Workspace,
    expected: &'a [Value],
    next: usize,
    merged: Workspace,
}
impl<'a> Assembly<'a> {
    pub(crate) fn new(base: &'a Workspace, expected: &'a [Value]) -> Result<Self> {
        validate_workspace(base)?;
        if expected.len() > 16 {
            return Err(failure("Too many source inputs"));
        }
        let mut tasks = BTreeSet::new();
        for input in expected {
            if !tasks.insert(field(input, "task_id")?) {
                return Err(failure("Duplicate captured task input"));
            }
            scopes(&input["write_paths"])?;
        }
        Ok(Self {
            base,
            expected,
            next: 0,
            merged: base.clone(),
        })
    }
    pub(crate) fn apply(&mut self, identity: &Value, files: &Workspace) -> Result<()> {
        let expected = self
            .expected
            .get(self.next)
            .ok_or_else(|| failure("Unexpected source input"))?;
        if expected != identity {
            return Err(failure(
                "Delivered source identity differs from the frozen manifest",
            ));
        }
        validate_workspace(files)?;
        let allowed = scopes(&expected["write_paths"])?;
        for path in changed(self.base, files)? {
            // A dependent capture contains its ancestors too. Apply only this task's owned delta.
            if contains(&allowed, &path) {
                if let Some(file) = files.get(&path) {
                    self.merged.insert(path, file.clone());
                } else {
                    self.merged.remove(&path);
                }
            }
        }
        validate_workspace(&self.merged)?;
        self.next += 1;
        Ok(())
    }
    pub(crate) fn finish(self) -> Result<Workspace> {
        if self.next != self.expected.len() {
            return Err(failure("A required captured source input is missing"));
        }
        Ok(self.merged)
    }
}

pub(crate) fn validate_changes(
    before: &Workspace,
    after: &Workspace,
    write_paths: &Value,
) -> Result<()> {
    validate_workspace(after)?;
    let allowed = scopes(write_paths)?;
    if changed(before, after)?
        .iter()
        .any(|path| !contains(&allowed, path))
    {
        return Err(Error::new(
            "TEAM_SCOPE",
            "Source changes exceed the frozen task write scope",
        ));
    }
    Ok(())
}

/// Planning may inspect the checkout, but cannot hand off modified source.
pub(crate) fn validate_read_only(before: &Workspace, after: &Workspace) -> Result<()> {
    validate_workspace(after)?;
    if !changed(before, after)?.is_empty() {
        return Err(Error::new(
            "PLANNING_SOURCE_CHANGED",
            "The planner changed source; no plan or source can be activated from this attempt",
        ));
    }
    Ok(())
}

fn changed(before: &Workspace, after: &Workspace) -> Result<Vec<String>> {
    let paths: BTreeSet<_> = before.keys().chain(after.keys()).collect();
    let mut result = Vec::new();
    for path in paths {
        let same = match (before.get(path), after.get(path)) {
            (Some(a), Some(b)) => a.executable == b.executable && a.bytes()? == b.bytes()?,
            _ => false,
        };
        if !same {
            result.push(path.clone());
        }
    }
    Ok(result)
}

fn scopes(value: &Value) -> Result<Vec<&str>> {
    let entries = value
        .as_array()
        .ok_or_else(|| failure("Missing frozen task write paths"))?;
    if entries.is_empty() || entries.len() > 32 {
        return Err(failure("Task write paths must be bounded"));
    }
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry
            .as_str()
            .ok_or_else(|| failure("Invalid task write path"))?;
        validate_path(path.strip_suffix('/').unwrap_or(path))?;
        paths.push(path);
    }
    Ok(paths)
}
fn contains(scopes: &[&str], path: &str) -> bool {
    scopes.iter().any(|scope| {
        if scope.ends_with('/') {
            path.starts_with(scope)
        } else {
            path == *scope
        }
    })
}
fn failure(message: &str) -> Error {
    Error::new("TEAM_SOURCE", message)
}

/// Assemble immutable exact-revision Git snapshots using the frozen task scopes.
pub(crate) fn assemble_git(
    base: &crate::transport::GitWorkspace,
    expected: &[Value],
    delivered: &[crate::transport::GitWorkspace],
) -> Result<crate::transport::GitWorkspace> {
    if expected.len() > 16 || expected.len() != delivered.len() {
        return Err(failure("Missing or excessive exact Git source inputs"));
    }
    let mut tasks = BTreeSet::new();
    let mut merged = base.clone();
    for (input, files) in expected.iter().zip(delivered) {
        if !tasks.insert(field(input, "task_id")?) {
            return Err(failure("Duplicate captured task input"));
        }
        let allowed = scopes(&input["write_paths"])?;
        for path in changed_git(base, files) {
            if !contains(&allowed, &path) {
                continue;
            }
            if let Some(file) = files.get(&path) {
                merged.insert(path, file.clone());
            } else {
                merged.remove(&path);
            }
        }
    }
    validate_git_shape(&merged)?;
    Ok(merged)
}

pub(crate) fn validate_changes_git(
    before: &crate::transport::GitWorkspace,
    after: &crate::transport::GitWorkspace,
    write_paths: &Value,
) -> Result<()> {
    let allowed = scopes(write_paths)?;
    if changed_git(before, after)
        .iter()
        .any(|path| !contains(&allowed, path))
    {
        return Err(Error::new(
            "TEAM_SCOPE",
            "Git source changes exceed frozen task write paths",
        ));
    }
    validate_git_shape(after)
}

fn changed_git(
    before: &crate::transport::GitWorkspace,
    after: &crate::transport::GitWorkspace,
) -> Vec<String> {
    let paths: BTreeSet<_> = before.keys().chain(after.keys()).collect();
    paths
        .into_iter()
        .filter(|path| match (before.get(*path), after.get(*path)) {
            (Some(left), Some(right)) => {
                left.executable != right.executable || left.bytes != right.bytes
            }
            (None, None) => false,
            _ => true,
        })
        .cloned()
        .collect()
}

fn validate_git_shape(files: &crate::transport::GitWorkspace) -> Result<()> {
    for path in files.keys() {
        validate_path(path)?;
        let mut prefix = path.as_str();
        while let Some((parent, _)) = prefix.rsplit_once('/') {
            if files.contains_key(parent) {
                return Err(failure("Git file is also a parent directory"));
            }
            prefix = parent;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests/team_workspace.rs"]
mod tests;
