//! Landing a pushed commit on a protected branch, while the branch's landing lock is held:
//! a fast-forward lands the pushed commit; otherwise the platform builds a merge commit
//! (`merge`), or the landing is refused on an overlap or a stale declared read. Local
//! checks (`checks`) run on whichever of the two would land.
use crate::authority::Cred;
use crate::moves::{Command, reason, short};
use crate::service::Service;
use crate::timing::{Clock, Phases};
use crate::{checks, merge, outbox};
use serde_json::{Value, json};
use std::collections::HashSet;
use yoneda_core::{Error, git_object::ObjectId};

/// Attempts at landing on a head that keeps moving (only another host sequence can move it).
const LAND_ATTEMPTS: usize = 8;

/// Lands `sha` on a protected branch: a fast-forward keeps the pushed commit; otherwise the
/// platform merges, or refuses an overlap. A commit the branch already holds lands nothing.
pub fn land(
    svc: &Service,
    cred: &Cred,
    c: &Command,
    sha: &str,
    fresh: &HashSet<String>,
    messages: &mut Vec<String>,
    phases: &mut Phases,
) -> Option<String> {
    let branch = short(&c.refname).to_owned();
    if !fresh.contains(sha) && already_holds(svc, cred, &c.refname, sha) {
        return None;
    }
    let _landing = svc.landing.lock().unwrap_or_else(|e| e.into_inner());
    let checked = checks::configured(svc, cred);
    for _ in 0..LAND_ATTEMPTS {
        // A fast-forward lands the pushed commit itself, so that is what is checked.
        if checked && fast_forwards(svc, cred, &c.refname, sha) {
            let running = Clock::start();
            let refused = checks::gate(svc, cred, sha, false, messages);
            phases.add("checks", running.ms());
            if refused.is_some() {
                return refused;
            }
        }
        let land = json!({ "op": "repo_land", "ref": c.refname, "commit": sha });
        let err = match svc.authority.call(cred, land) {
            Ok(answer) => return landed(svc, &branch, &answer, false, messages),
            Err(e) if e.code == "MERGE_REQUIRED" => e,
            Err(e) => return refused(&e, messages),
        };
        let merging = Clock::start();
        let built = merge::build(&svc.authority, cred, &svc.store, &c.refname, sha);
        phases.add("merge", merging.ms());
        let merge = match built {
            Ok(id) => id,
            Err(e) if e.code == "CONFLICT" => return refused(&e, messages),
            Err(e) => {
                eprintln!("yoneda-local: merging into {branch} failed: {}", reason(&e));
                return refused(&err, messages);
            }
        };
        if checked {
            let running = Clock::start();
            // The check's checkout reads the merge commit from the store.
            if let Err(e) = outbox::drain(svc) {
                return Some(format!("checks could not start: {}", e.message));
            }
            let refused = checks::gate(svc, cred, &merge.hex(), true, messages);
            phases.add("checks", running.ms());
            if refused.is_some() {
                return refused;
            }
        }
        let land = json!({ "op": "repo_land", "ref": c.refname, "commit": sha, "merge": merge });
        match svc.authority.call(cred, land) {
            Ok(answer) => {
                phases.merged = true;
                return landed(svc, &branch, &answer, true, messages);
            }
            Err(e)
                if matches!(
                    e.code.as_str(),
                    "STALE_PARENT" | "STALE_HEAD" | "MERGE_REQUIRED"
                ) => {}
            Err(e) => return refused(&e, messages),
        }
    }
    Some("OVERLOADED: the branch kept moving; push again".into())
}

/// Whether landing `sha` on `refname` now would be a fast-forward.
fn fast_forwards(svc: &Service, cred: &Cred, refname: &str, sha: &str) -> bool {
    let head = svc
        .authority
        .call(cred, json!({ "op": "repo_snapshot", "ref": refname }));
    let (Ok(head), Ok(tip)) = (head, ObjectId::parse(sha)) else {
        return false;
    };
    ObjectId::parse(head["commit"].as_str().unwrap_or_default())
        .is_ok_and(|h| h == tip || svc.store.is_ancestor(&h, &tip))
}

fn already_holds(svc: &Service, cred: &Cred, refname: &str, sha: &str) -> bool {
    let Ok(head) = svc
        .authority
        .call(cred, json!({ "op": "repo_snapshot", "ref": refname }))
    else {
        return false;
    };
    let head = head["commit"].as_str().unwrap_or_default();
    if head == sha {
        return true;
    }
    svc.authority
        .call(
            cred,
            json!({ "op": "repo_merge_base", "left": sha, "right": head }),
        )
        .is_ok_and(|mb| {
            mb["merge_bases"]
                .as_array()
                .is_some_and(|bases| bases.iter().any(|b| b["commit"] == sha))
        })
}

fn landed(
    svc: &Service,
    branch: &str,
    answer: &Value,
    merged: bool,
    messages: &mut Vec<String>,
) -> Option<String> {
    if merged {
        messages.push(format!("{branch}: landed with server merge, run git pull"));
    }
    if branch == svc.config.branch
        && answer["already"] != true
        && let Some(version) = answer["version"].as_u64()
    {
        svc.landed_on_branch(version);
    }
    None
}

/// A refused landing as Git shows it: the stale reads or conflicting paths, and what next.
fn refused(e: &Error, messages: &mut Vec<String>) -> Option<String> {
    if e.code != "CONFLICT" {
        return Some(reason(e));
    }
    let read = merge::stale_reads(e);
    if !read.is_empty() {
        for path in &read {
            messages.push(format!(
                "read conflict on {path}: it changed after your base"
            ));
        }
        messages.push("next: git pull, check your change still holds, git push".into());
        return Some(
            format!("read conflict on {}: run git pull", read.join(", "))
                .chars()
                .take(300)
                .collect(),
        );
    }
    let paths = merge::conflict_paths(e);
    for path in &paths {
        messages.push(format!("conflict in {path}"));
    }
    messages.push("next: git pull, resolve the conflicts, commit, git push".into());
    let listed = if paths.is_empty() {
        String::new()
    } else {
        format!(" in {}", paths.join(", "))
    };
    Some(
        format!("conflict{listed}: run git pull")
            .chars()
            .take(300)
            .collect(),
    )
}
