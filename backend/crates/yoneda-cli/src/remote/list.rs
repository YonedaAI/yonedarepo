//! `list` and `list for-push`: the platform's branches and tags, by the platform's commit
//! ids (an annotated tag by its tag object's id).
use super::Session;
use super::fetch::Fetcher;
use super::tags;
use crate::error::{Error, Result};
use serde_json::Value;
use std::collections::BTreeMap;

pub const MAIN: &str = "refs/heads/main";

/// The platform's refs at one version.
pub struct Listed {
    pub version: u64,
    /// Branches and tags: refname → commit.
    pub heads: BTreeMap<String, String>,
    /// Annotated tags: refname → tag object id.
    pub annotated: BTreeMap<String, String>,
}

fn named(value: &Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(name, _)| name.starts_with("refs/heads/") || name.starts_with("refs/tags/"))
        .filter_map(|(name, sha)| Some((name.clone(), sha.as_str()?.to_owned())))
        .collect()
}

/// The platform's branches and tags at its latest version.
pub async fn branches(session: &Session) -> Result<Listed> {
    let refs = session.api.get("/refs").await?;
    let version = refs["version"]
        .as_u64()
        .ok_or_else(|| Error::new("the platform's refs have no version"))?;
    Ok(Listed {
        version,
        heads: named(&refs["refs"]),
        annotated: named(&refs["annotated"]),
    })
}

pub async fn list(session: &mut Session, for_push: bool) -> Result<String> {
    let Listed {
        version,
        heads,
        annotated,
    } = branches(session).await?;
    let mut out = String::new();
    for (name, server) in &heads {
        let local = if let Some(tag) = annotated.get(name) {
            // Git compares a tag push with the tag object it names.
            if for_push {
                tag.clone()
            } else {
                tags::listed(session, name, server, tag).await?
            }
        } else if name == MAIN {
            session.heads.record(server, version)?;
            let branch = Some("main");
            let local = Fetcher::new(
                &session.api,
                &session.git,
                &mut session.map,
                &session.filter,
            )
            .local(server, branch)
            .await?;
            if for_push {
                main_for_push(session, &local)
            } else {
                local
            }
        } else if for_push {
            // Git compares the push with this; a commit it lacks is "fetch first", as
            // with any remote that moved.
            session.held(server).unwrap_or_else(|| server.clone())
        } else {
            // A tag names no branch whose log could list its history in one request.
            let branch = name.strip_prefix("refs/heads/");
            Fetcher::new(
                &session.api,
                &session.git,
                &mut session.map,
                &session.filter,
            )
            .local(server, branch)
            .await?
        };
        out.push_str(&format!("{local} {name}\n"));
    }
    if heads.contains_key(MAIN) {
        out.push_str(&format!("@{MAIN} HEAD\n"));
    }
    out.push('\n');
    Ok(out)
}

/// What Git compares a push to main against. Landing merges concurrent changes on the
/// platform, so a main that moved is no reason to refuse: main reports its newest commit
/// that the work being pushed (HEAD) builds on, their merge base. Work main already holds
/// reports itself (Git then says everything is up to date); unrelated work reports main,
/// which Git refuses as non-fast-forward.
fn main_for_push(session: &Session, main: &str) -> String {
    if session.git.is_ancestor(main, "HEAD") {
        return main.to_owned();
    }
    session
        .git
        .run(&["merge-base", "HEAD", main])
        .ok()
        .filter(|base| !base.is_empty())
        .unwrap_or_else(|| main.to_owned())
}
