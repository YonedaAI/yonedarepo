//! Directory grants (Scion S16): a repository token may be limited to path prefixes.
//! Every read, search, write, review, land and contract record checks them; anything
//! outside the grant is refused with one uniform error, so refusals reveal nothing about
//! what exists there.
use crate::storage::bad;
use serde_json::Value;
use yoneda_core::{Error, Result, txlog::Access};

/// `None`: the whole repository. Entries are file paths or directory prefixes.
pub type Grant = Option<Vec<String>>;

fn trimmed(entry: &str) -> &str {
    entry.trim_end_matches('/')
}

/// Whether `path` (a file or directory) lies inside the grant.
pub fn allows(grant: &Grant, path: &str) -> bool {
    let Some(entries) = grant else { return true };
    let path = trimmed(path);
    entries.iter().any(|g| {
        let g = trimmed(g);
        path == g
            || path
                .strip_prefix(g)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Whether listing directory `dir` is allowed: inside the grant, or on the way to it.
pub fn sees(grant: &Grant, dir: &str) -> bool {
    let Some(entries) = grant else { return true };
    let dir = trimmed(dir);
    dir.is_empty()
        || allows(grant, dir)
        || entries.iter().any(|g| {
            trimmed(g)
                .strip_prefix(dir)
                .is_some_and(|rest| rest.starts_with('/'))
        })
}

pub fn outside() -> Error {
    Error::new("FORBIDDEN", "Path is outside your grant")
}

pub fn require(grant: &Grant, path: &str) -> Result<()> {
    if allows(grant, path) {
        Ok(())
    } else {
        Err(outside())
    }
}

/// Validates a grant given at token creation.
pub fn parse(value: &Value) -> Result<Grant> {
    if value.is_null() {
        return Ok(None);
    }
    let entries: Vec<String> =
        serde_json::from_value(value.clone()).map_err(|_| bad("paths must be a list"))?;
    if entries.is_empty() || entries.len() > 100 {
        return Err(bad("A grant lists 1-100 paths"));
    }
    for entry in &entries {
        yoneda_core::validate_path(trimmed(entry))?;
    }
    Ok(Some(entries))
}

/// Keeps only items whose `key` path is inside the grant.
pub fn filter(grant: &Grant, items: Vec<Value>, key: &str) -> Vec<Value> {
    items
        .into_iter()
        .filter(|item| allows(grant, item[key].as_str().unwrap_or_default()))
        .collect()
}

/// Grant checks that must pass before an operation runs: writes stay inside the grant,
/// and reviewing, checking or landing a commit requires seeing all of its changes.
pub fn precheck<S: crate::storage::SqlStore>(
    db: &S,
    op: &str,
    c: &Value,
    grant: &Grant,
) -> Result<()> {
    if grant.is_none() {
        return Ok(());
    }
    match op {
        "repo_prepare_commit" => {
            for change in c["changes"].as_array().into_iter().flatten() {
                require(grant, change["path"].as_str().unwrap_or_default())?;
            }
        }
        "repo_begin_commit" => {
            for path in c["paths"].as_array().into_iter().flatten() {
                require(grant, path.as_str().unwrap_or_default())?;
            }
        }
        "repo_land" | "repo_land_enqueue" | "repo_review" | "repo_check" | "repo_check_request" => {
            let id = super::rows::object_id(c, "commit")?;
            for touch in super::rows::touches(db, &id)? {
                require(grant, &touch.path)?;
            }
        }
        "repo_path_history" | "repo_record_contract" => {
            require(grant, c["path"].as_str().unwrap_or_default())?
        }
        "repo_contracts" => {
            for path in super::contracts::paths(c)? {
                require(grant, &path)?;
            }
        }
        // Whether a hidden path was written since is itself hidden.
        "repo_stale_reads" => {
            for item in c["items"].as_array().into_iter().flatten() {
                for entry in item["read_set"].as_array().into_iter().flatten() {
                    let access = Access::parse(entry.as_str().unwrap_or_default());
                    require(grant, access.path())?;
                }
            }
        }
        // Check output can include any file's content.
        "repo_check_run" | "repo_set_policy" | "repo_vacuum_plan" => return Err(outside()),
        _ => {}
    }
    Ok(())
}

/// Removes paths outside the grant from read results.
pub fn redact(op: &str, grant: &Grant, mut result: Value) -> Value {
    if op == "repo_status" {
        result["grant"] = serde_json::json!(grant);
    }
    if grant.is_none() {
        return result;
    }
    match op {
        "repo_commit" => {
            let paths = result["paths"].as_array().cloned().unwrap_or_default();
            result["paths"] = Value::Array(filter(grant, paths, "path"));
            if let Some(files) = result["review_classes"]["files"].as_array().cloned() {
                result["review_classes"]["files"] = Value::Array(filter(grant, files, "path"));
            }
            let touches = result["symbol_touches"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            result["symbol_touches"] = Value::Array(filter(grant, touches, "path"));
        }
        "repo_contracts" => {
            let records = result["records"].as_array().cloned().unwrap_or_default();
            result["records"] = Value::Array(filter(grant, records, "path"));
        }
        "repo_txlog" => {
            for entry in result["entries"].as_array_mut().into_iter().flatten() {
                let paths = entry["paths"].as_array().cloned().unwrap_or_default();
                entry["paths"] = Value::Array(filter(grant, paths, "path"));
            }
        }
        _ => {}
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_match_whole_segments() {
        let grant: Grant = Some(vec!["public/".into(), "docs/a.md".into()]);
        assert!(
            allows(&grant, "public/x/y.rs")
                && allows(&grant, "public")
                && allows(&grant, "docs/a.md")
        );
        assert!(
            !allows(&grant, "publicity/x")
                && !allows(&grant, "docs/b.md")
                && !allows(&grant, "secret/x")
        );
        assert!(sees(&grant, "") && sees(&grant, "docs") && !sees(&grant, "secret"));
        assert!(allows(&None, "anything"));
    }
}
