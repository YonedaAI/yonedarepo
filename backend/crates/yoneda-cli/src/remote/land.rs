//! A push to main lands the uploaded tip: the platform fast-forwards it, or merges it
//! with concurrent changes to other lines and files, or refuses an overlap as CONFLICT.
use super::convert::Converter;
use super::upload::Uploaded;
use super::{Session, say};
use crate::api::Failure;
use crate::error::Context;
use serde_json::{Value, json};

/// Lands `done.tip` (made from local commit `local`) on main and maps main's new head.
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
    say(&format!(
        "landed {} on main at version {version}",
        &local[..local.len().min(12)]
    ));
    // The uploaded commits are ours before main's head is converted.
    let entries: Vec<(String, String, u64)> = done
        .made
        .iter()
        .map(|(server, local)| (server.clone(), local.clone(), 0))
        .collect();
    session.map.record(&entries).map_err(|e| e.message)?;
    let tree = session.git.tree_of(local).map_err(|e| e.message)?;
    let mut convert = Converter::new(&session.api, &session.git, &mut session.map);
    let head_tree = convert.info(&head).await.map_err(|e| e.message)?.tree;
    if head == done.tip || head_tree == tree {
        // Main holds exactly this tree: it is the pushed commit, as far as Git is concerned.
        session
            .map
            .record(&[(head, local.to_owned(), latest)])
            .map_err(|e| e.message)?;
    } else {
        convert
            .convert_landing(&head, local, latest)
            .await
            .map_err(|e| e.message)?;
        say("server merged concurrent changes; run git pull");
    }
    Ok(())
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
