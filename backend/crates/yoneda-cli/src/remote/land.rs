//! A push to main lands the uploaded tip: main becomes the pushed commit itself (a
//! fast-forward, or the first push into an empty repository), or the platform merges it
//! with concurrent changes to other lines and files (a merge commit whose parents include
//! the pushed commit, so the next `git pull` fast-forwards), or refuses an overlap as
//! CONFLICT.
use super::upload::Uploaded;
use super::{Session, say};
use crate::api::Failure;
use crate::error::Context;
use serde_json::{Value, json};

/// Lands `done.tip` (made from local commit `local`) on main.
pub async fn land(session: &mut Session, local: &str, done: &Uploaded) -> Result<(), String> {
    let landed = match session.api.land("main", &done.tip).await {
        Ok(landed) => landed,
        Err(f) if f.code == "CONFLICT" => return Err(conflict(session, &f)),
        Err(f) => return Err(format!("{}: {}", f.code, f.message)),
    };
    let (latest, head) = session
        .api
        .branch_at_latest("main")
        .await
        .map_err(|f| format!("landed, but reading main back failed ({f}); run git pull"))?;
    let version = landed["version"].as_u64().unwrap_or(latest);
    let _ = std::fs::remove_file(session.conflict_path());
    if let Err(e) = session.heads.record(&head, latest) {
        say(&e.message);
    }
    if head == done.tip {
        say(&format!("landed as {} at version {version}", short(local)));
    } else {
        say(&format!(
            "landed {} at version {version}; server merged concurrent changes (main is at {}); git pull fast-forwards",
            short(local),
            short(&head)
        ));
    }
    Ok(())
}

fn short(id: &str) -> &str {
    &id[..id.len().min(12)]
}

/// Reports a refused landing: the paths on stderr and in the conflict file.
fn conflict(session: &Session, failure: &Failure) -> String {
    let paths = conflict_paths(&failure.details);
    say(&format!("landing on main refused: {}", failure.message));
    for path in &paths {
        say(&format!("conflict in {path}"));
    }
    say("next: git pull, resolve the conflicts, commit, git push");
    let record = json!({ "message": failure.message, "paths": paths, "details": failure.details });
    let file = session.conflict_path();
    let saved = file
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&file, record.to_string()))
        .context(format!("writing {}", file.display()));
    if let Err(e) = saved {
        say(&e.message);
    }
    "conflict".into()
}

/// The conflicting paths a CONFLICT names (`details.conflicts[].path` or `details.paths`).
pub fn conflict_paths(details: &Value) -> Vec<String> {
    let named = details["conflicts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["path"].as_str().or_else(|| c.as_str()));
    let listed = details["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let mut paths: Vec<String> = named.chain(listed).map(str::to_owned).collect();
    paths.sort();
    paths.dedup();
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_conflict_paths_in_either_shape() {
        let details =
            json!({"conflicts":[{"path":"b.txt","base":"x"},{"path":"a.txt"}],"paths":["a.txt"]});
        assert_eq!(conflict_paths(&details), ["a.txt", "b.txt"]);
        assert!(conflict_paths(&Value::Null).is_empty());
    }
}
