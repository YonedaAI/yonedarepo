//! Git-derived path analysis and three-way candidate merge for trusted refresh jobs.
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path};
use tokio::process::Command;
use yoneda_core::Result;

/// Rebase a captured candidate onto an observed head using only local Git objects.
/// The adapter must fetch/materialize the three commits before invoking this function.
pub async fn refresh(
    repository: &Path,
    base: &str,
    observed_head: &str,
    candidate: &str,
    candidate_repository: &str,
    declared_paths: &[String],
) -> Result<Value> {
    for commit in [base, observed_head, candidate] {
        if ![40, 64].contains(&commit.len()) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(err("Invalid reserved Git object identity"));
        }
        git(
            repository,
            &["cat-file", "-e", &format!("{commit}^{{commit}}")],
        )
        .await?;
    }
    let parents = git(repository, &["rev-list", "--parents", "-n", "1", candidate]).await?;
    let ancestry = parents.split_whitespace().collect::<Vec<_>>();
    if !(2..=3).contains(&ancestry.len()) || ancestry[0] != candidate || ancestry[1] != base {
        return Err(err(
            "Candidate does not have the reserved base as its parent",
        ));
    }
    git(
        repository,
        &["merge-base", "--is-ancestor", base, observed_head],
    )
    .await?;
    let captured = paths(repository, base, candidate).await?;
    let intervening = paths(repository, base, observed_head).await?;
    let declared: BTreeSet<_> = declared_paths.iter().collect();
    if declared_paths.is_empty()
        || declared_paths.len() > 10_000
        || declared.len() != declared_paths.len()
    {
        return Err(err(
            "Owner-approved path manifest is empty, excessive, or duplicated",
        ));
    }
    for scope in declared_paths {
        yoneda_core::validate_path(scope.strip_suffix('/').unwrap_or(scope))?;
    }
    if captured.iter().any(|path| {
        !declared_paths
            .iter()
            .any(|scope| path == scope || (scope.ends_with('/') && path.starts_with(scope)))
    }) {
        return Err(err(
            "Captured Git paths exceed the owner-approved declared scopes",
        ));
    }
    let overlapping: Vec<_> = captured
        .iter()
        .filter(|path| intervening.contains(path))
        .cloned()
        .collect();
    let evidence = json!({
        "base_commit":base,
        "observed_head":observed_head,
        "candidate_commit":candidate,
        "declared_paths":declared_paths,
        "captured_paths":captured,
        "intervening_paths":intervening,
        "overlapping_paths":overlapping,
    });
    let merged = command(
        repository,
        &["merge-tree", "--write-tree", observed_head, candidate],
    )
    .await?;
    let output = String::from_utf8_lossy(&merged.stdout);
    let tree = output.lines().next().unwrap_or_default().trim();
    if ![40, 64].contains(&tree.len()) || !tree.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(err("Git did not return a merge tree"));
    }
    let unresolved = if merged.status.success() {
        Vec::new()
    } else {
        conflict_paths(&output)
    };
    if !merged.status.success() && unresolved.is_empty() {
        return Err(err("Git merge failed without structured conflict paths"));
    }
    // Even an unresolved merge tree is a useful private resolver workspace:
    // Git stores conflict markers plus all cleanly merged candidate changes.
    let workspace_commit = git(
        repository,
        &[
            "-c",
            "user.name=YonedaRepo conflict workspace",
            "-c",
            "user.email=conflict@yoneda.invalid",
            "commit-tree",
            tree,
            "-p",
            observed_head,
            "-p",
            candidate,
            "-m",
            "Conflict resolver workspace (not selectable)",
        ],
    )
    .await?;
    let commit = unresolved.is_empty().then_some(workspace_commit.clone());
    let merged_paths = if let Some(commit) = commit.as_deref() {
        paths(repository, observed_head, commit).await?
    } else {
        Vec::new()
    };
    Ok(
        json!({"evidence":evidence,"merge_commit":commit,"merge_tree":tree,
        "candidate_id":commit.as_ref().map(|c|format!("candidate:refresh:{c}")),
        "revision":commit.as_ref().map(|c|json!({"repository":candidate_repository,"commit":c})),
        "tree":tree,"paths":merged_paths,"conflict_paths":unresolved,
        "merge_workspace_commit":if commit.is_none(){Some(workspace_commit)}else{None},
        "status":if commit.is_some(){"clean"}else{"unresolved"}}),
    )
}

/// Execute a persisted capture-subtype job using only its ledger-issued fields.
pub async fn execute_refresh_job(job: &Value, repository: &Path) -> Result<Value> {
    if job["kind"] != "capture" || job["payload"]["capture_subtype"] != "refresh_candidate" {
        return Err(err("Job is not a candidate refresh capture"));
    }
    let payload = &job["payload"];
    let base = payload["expected_base"]
        .as_str()
        .ok_or_else(|| err("Missing reserved base"))?;
    let head = payload["expected_head"]
        .as_str()
        .ok_or_else(|| err("Missing reserved head"))?;
    let candidate = payload["candidate"]["revision"]["commit"]
        .as_str()
        .ok_or_else(|| err("Missing captured candidate revision"))?;
    let repository_id = payload["candidate"]["revision"]["repository"]
        .as_str()
        .ok_or_else(|| err("Missing candidate repository identity"))?;
    let declared = payload["declared_paths"]
        .as_array()
        .ok_or_else(|| err("Missing owner-approved scopes"))?
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or_else(|| err("Invalid owner-approved scope"))
        })
        .collect::<Result<Vec<_>>>()?;
    refresh(repository, base, head, candidate, repository_id, &declared).await
}

async fn paths(repository: &Path, base: &str, target: &str) -> Result<Vec<String>> {
    let output = command(
        repository,
        &["diff", "--no-renames", "--name-only", "-z", base, target],
    )
    .await?;
    if !output.status.success() {
        return Err(err(&String::from_utf8_lossy(&output.stderr)));
    }
    let set: BTreeSet<_> = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| {
            String::from_utf8(path.to_vec()).map_err(|_| err("Git path is not valid UTF-8"))
        })
        .collect::<Result<_>>()?;
    Ok(set.into_iter().collect())
}

fn conflict_paths(output: &str) -> Vec<String> {
    let mut paths = BTreeSet::new();
    for line in output.lines() {
        if let Some((_, path)) = line.rsplit_once(" in ")
            && line.starts_with("CONFLICT (")
        {
            paths.insert(path.trim().to_owned());
        }
    }
    paths.into_iter().collect()
}

async fn git(repository: &Path, args: &[&str]) -> Result<String> {
    let output = command(repository, args).await?;
    if !output.status.success() {
        return Err(err(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

async fn command(repository: &Path, args: &[&str]) -> Result<std::process::Output> {
    Command::new("/usr/bin/git")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.file.allow=never",
        ])
        .args(args)
        .current_dir(repository)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", "/nonexistent")
        .env("LANG", "C.UTF-8")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "3")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", "/dev/null")
        .env("GIT_CONFIG_KEY_1", "core.attributesFile")
        .env("GIT_CONFIG_VALUE_1", "/dev/null")
        .env("GIT_CONFIG_KEY_2", "protocol.file.allow")
        .env("GIT_CONFIG_VALUE_2", "never")
        .output()
        .await
        .map_err(|error| err(&error.to_string()))
}

fn err(message: &str) -> yoneda_core::Error {
    yoneda_core::Error::new("CONFLICT_MERGE", message)
}

#[cfg(test)]
#[path = "tests/conflict_merge.rs"]
mod tests;
