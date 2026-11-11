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
use crate::service::Service;
use crate::timing::Phases;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use yoneda_core::Error;

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

pub fn short(refname: &str) -> &str {
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
    phases: &mut Phases,
) -> Option<String> {
    if c.protected
        && let Some(sha) = c.new.as_deref()
    {
        return crate::land::land(svc, cred, c, sha, fresh, messages, phases);
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
