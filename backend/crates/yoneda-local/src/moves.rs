//! The ref updates of a push once its objects are stored, as
//! `cloudflare/worker/repo-git-moves.ts` makes them: working branches by compare-and-swap
//! (one batch for `--atomic`), protected branches by landing, with the platform's merge
//! when they moved meanwhile, and new tags by creation.
//!
//! One difference from the cloud: a landing that needs a merge is merged and landed here
//! directly (`repo_merge_plan`, then `repo_land` with `merge`), not queued for the
//! branch's combiner. Both are the engine's own landing paths; the authority verifies the
//! merge either way.
use crate::authority::Cred;
use crate::merge;
use crate::service::Service;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use yoneda_core::Error;

/// Attempts at landing on a head that keeps moving (only another host sequence can move it).
const LAND_ATTEMPTS: usize = 8;

#[derive(Clone, Debug, Deserialize)]
pub struct Command {
    #[serde(rename = "ref")]
    pub refname: String,
    pub old: Option<String>,
    pub new: Option<String>,
    pub protected: bool,
    pub annotated: bool,
    pub tag: Option<Value>,
    pub tag_error: Option<String>,
}

impl Command {
    /// The commit the command moves its ref to (an annotated tag's tagged commit).
    pub fn target(&self) -> Option<String> {
        self.tag
            .as_ref()
            .and_then(|t| t["commit"].as_str().map(str::to_owned))
            .or_else(|| self.new.clone())
    }
    fn update(&self) -> Value {
        let mut u = json!({ "ref": self.refname, "commit": self.target(), "expected": self.old });
        if let Some(tag) = &self.tag {
            u["tag"] = json!({ "data_b64": tag["data_b64"] });
        }
        u
    }
}

pub type Outcomes = HashMap<String, Option<String>>;

pub fn reason(e: &Error) -> String {
    format!("{}: {}", e.code, e.message)
        .chars()
        .take(300)
        .collect()
}

fn short(refname: &str) -> &str {
    refname.trim_start_matches("refs/heads/")
}

/// Why a ref is refused before anything is stored (`None`: it goes ahead).
pub fn refusal(c: &Command, atomic: bool) -> Option<String> {
    if c.refname.starts_with("refs/tags/") {
        return if c.new.is_none() {
            Some("tags are immutable and cannot be deleted".into())
        } else if c.annotated && c.tag.is_none() {
            let why = c.tag_error.as_deref().unwrap_or("unreadable");
            Some(
                format!("invalid tag object: {why}")
                    .chars()
                    .take(300)
                    .collect(),
            )
        } else if c.old.is_some() {
            Some("tags are immutable: this tag already exists".into())
        } else {
            None
        };
    }
    if !c.refname.starts_with("refs/heads/") {
        return Some("only branches (refs/heads/*) and tags (refs/tags/*) can be pushed".into());
    }
    if c.protected && c.new.is_none() {
        return Some(format!(
            "{} is protected and cannot be deleted",
            short(&c.refname)
        ));
    }
    if c.protected && atomic {
        let name = short(&c.refname);
        return Some(format!(
            "an atomic push cannot include {name}: it moves only by landing"
        ));
    }
    None
}

/// `--atomic`: every working branch move and tag creation in one transaction, or none.
pub fn move_all(
    svc: &Service,
    cred: &Cred,
    going: &[&Command],
    outcomes: &mut Outcomes,
    _: &mut Vec<String>,
) {
    if going.is_empty() {
        return;
    }
    let updates: Vec<Value> = going.iter().map(|c| c.update()).collect();
    match svc.authority.call(
        cred,
        json!({ "op": "repo_branch_batch", "updates": updates }),
    ) {
        Ok(moved) => {
            let stale: Vec<String> =
                serde_json::from_value(moved["stale"].clone()).unwrap_or_default();
            if !stale.is_empty() {
                for c in going {
                    let why = if stale.contains(&c.refname) {
                        "fetch first"
                    } else {
                        "atomic push refused"
                    };
                    outcomes.insert(c.refname.clone(), Some(why.into()));
                }
            }
        }
        Err(e) => {
            for c in going {
                outcomes.insert(c.refname.clone(), Some(reason(&e)));
            }
        }
    }
}

/// One ref: a working branch (or tag) by compare-and-swap, a protected one by landing.
pub fn move_one(
    svc: &Service,
    cred: &Cred,
    c: &Command,
    fresh: &HashSet<String>,
    messages: &mut Vec<String>,
) -> Option<String> {
    if c.protected
        && let Some(sha) = c.new.as_deref()
    {
        return land(svc, cred, c, sha, fresh, messages);
    }
    match svc.authority.call(
        cred,
        json!({ "op": "repo_branch_batch", "updates": [c.update()] }),
    ) {
        Ok(moved) if moved["stale"].as_array().is_some_and(|s| !s.is_empty()) => {
            Some("fetch first".into())
        }
        Ok(_) => None,
        Err(e) => Some(reason(&e)),
    }
}

/// Lands `sha` on a protected branch: a fast-forward keeps the pushed commit; otherwise the
/// platform merges, or refuses an overlap. A commit the branch already holds lands nothing.
fn land(
    svc: &Service,
    cred: &Cred,
    c: &Command,
    sha: &str,
    fresh: &HashSet<String>,
    messages: &mut Vec<String>,
) -> Option<String> {
    let branch = short(&c.refname).to_owned();
    if !fresh.contains(sha) && already_holds(svc, cred, &c.refname, sha) {
        return None;
    }
    let _landing = svc.landing.lock().unwrap_or_else(|e| e.into_inner());
    for _ in 0..LAND_ATTEMPTS {
        let land = json!({ "op": "repo_land", "ref": c.refname, "commit": sha });
        let err = match svc.authority.call(cred, land) {
            Ok(answer) => return landed(svc, &branch, &answer, false, messages),
            Err(e) if e.code == "MERGE_REQUIRED" => e,
            Err(e) => return refused(&e, messages),
        };
        let merge = match merge::build(&svc.authority, cred, &svc.store, &c.refname, sha) {
            Ok(id) => id,
            Err(e) if e.code == "CONFLICT" => return refused(&e, messages),
            Err(_) => return refused(&err, messages),
        };
        let land = json!({ "op": "repo_land", "ref": c.refname, "commit": sha, "merge": merge });
        match svc.authority.call(cred, land) {
            Ok(answer) => return landed(svc, &branch, &answer, true, messages),
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
    if branch == "main"
        && answer["already"] != true
        && let Some(version) = answer["version"].as_u64()
    {
        svc.landed_on_main(version);
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
