//! `list` and `list for-push`: the platform's branches, by the platform's commit ids.
use super::Session;
use super::fetch::Fetcher;
use crate::error::{Error, Result};
use std::collections::BTreeMap;

pub const MAIN: &str = "refs/heads/main";

/// The platform's branches at its latest version: (version, refname → commit).
pub async fn branches(session: &Session) -> Result<(u64, BTreeMap<String, String>)> {
    let refs = session.api.get("/refs").await?;
    let version = refs["version"]
        .as_u64()
        .ok_or_else(|| Error::new("the platform's refs have no version"))?;
    let heads = refs["refs"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(name, _)| name.starts_with("refs/heads/"))
        .filter_map(|(name, sha)| Some((name.clone(), sha.as_str()?.to_owned())))
        .collect();
    Ok((version, heads))
}

pub async fn list(session: &mut Session, for_push: bool) -> Result<String> {
    let (version, heads) = branches(session).await?;
    let mut out = String::new();
    for (name, server) in &heads {
        let local = if name == MAIN {
            session.heads.record(server, version)?;
            let branch = Some("main");
            let local = Fetcher::new(&session.api, &session.git, &mut session.map)
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
            let branch = name.trim_start_matches("refs/heads/");
            Fetcher::new(&session.api, &session.git, &mut session.map)
                .local(server, Some(branch))
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
