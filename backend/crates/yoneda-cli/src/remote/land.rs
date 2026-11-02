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
    let (latest, head) = read_back(session, &landed).await?;
    let version = landed["version"].as_u64().unwrap_or(latest);
    let _ = std::fs::remove_file(session.conflict_path());
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

/// Remember the acknowledged landing before reading a potentially cached main back.
async fn read_back(session: &mut Session, landed: &Value) -> Result<(u64, String), String> {
    super::list::observe_write(session, landed)?;
    let listed = super::list::branches(session)
        .await
        .map_err(|error| format!("landed, but reading main back failed ({error}); run git pull"))?;
    let head = listed
        .heads
        .get(super::list::MAIN)
        .cloned()
        .ok_or_else(|| "landed, but the platform returned no main; run git pull".to_owned())?;
    session
        .heads
        .record(&head, listed.version)
        .map_err(|error| format!("landed, but recording main failed ({error}); run git pull"))?;
    Ok((listed.version, head))
}

fn short(id: &str) -> &str {
    &id[..id.len().min(12)]
}

/// Reports a refused landing: the paths on stderr and in the conflict file. A stale
/// declared read (a file the push read changed after its base) is a read conflict.
fn conflict(session: &Session, failure: &Failure) -> String {
    let read = stale_reads(&failure.message);
    let paths = if read.is_empty() {
        conflict_paths(&failure.details)
    } else {
        read.clone()
    };
    say(&format!("landing on main refused: {}", failure.message));
    if read.is_empty() {
        for path in &paths {
            say(&format!("conflict in {path}"));
        }
        say("next: git pull, resolve the conflicts, commit, git push");
    } else {
        for path in &paths {
            say(&format!(
                "read conflict on {path}: it changed after your base"
            ));
        }
        say("next: git pull, check your change still holds, git push");
    }
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
    if read.is_empty() {
        "conflict".into()
    } else {
        format!("read conflict on {}: run git pull", read.join(", "))
    }
}

/// The declared reads a stale-read CONFLICT names ("… at version N on <paths>, which this
/// commit read").
fn stale_reads(message: &str) -> Vec<String> {
    message
        .split_once(", which this commit read")
        .and_then(|(head, _)| head.split_once(" at version "))
        .and_then(|(_, rest)| rest.split_once(" on "))
        .map(|(_, paths)| paths.split(", ").map(str::to_owned).collect())
        .unwrap_or_default()
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

    #[tokio::test]
    async fn landing_readback_cannot_drop_the_committed_version() {
        use std::io::{Read, Write};
        let dir = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut input = [0; 4096];
            let n = socket.read(&mut input).unwrap();
            let fresh = String::from_utf8_lossy(&input[..n]).contains("min_version=7");
            let body = json!({"version": if fresh {7} else {6}, "refs":{"refs/heads/main": if fresh {"b".repeat(40)} else {"a".repeat(40)}}, "annotated":{}}).to_string();
            write!(socket, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let mut session = super::super::test_support::session(&origin, dir.path()).unwrap();
        let (_, head) = read_back(&mut session, &json!({"version":7}))
            .await
            .unwrap();
        assert_eq!(session.heads.minimum_version(), 7);
        assert_eq!(head, "b".repeat(40));
        server.join().unwrap();
    }

    #[test]
    fn reads_conflict_paths_in_either_shape() {
        let details =
            json!({"conflicts":[{"path":"b.txt","base":"x"},{"path":"a.txt"}],"paths":["a.txt"]});
        assert_eq!(conflict_paths(&details), ["a.txt", "b.txt"]);
        assert!(conflict_paths(&Value::Null).is_empty());
    }

    #[test]
    fn names_the_reads_of_a_stale_read_conflict() {
        let message = "refs/heads/main changed at version 4 on config.json, src/a.rs, which this commit read; reconcile and re-check";
        assert_eq!(stale_reads(message), ["config.json", "src/a.rs"]);
        assert!(stale_reads("Merge conflict in f.txt").is_empty());
    }
}
