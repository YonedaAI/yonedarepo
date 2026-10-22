//! `list` and `list for-push`: the platform's branches as local commit ids.
use super::Session;
use super::convert::Converter;
use crate::error::{Error, Result};
use std::collections::BTreeMap;

pub const MAIN: &str = "refs/heads/main";
/// Main's recent heads checked when choosing what `list for-push` reports for main.
const MAIN_CANDIDATES: usize = 50;

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
        let local = if for_push {
            for_push_value(session, name, server)
        } else {
            let branch = name.trim_start_matches("refs/heads/");
            let at = if name == MAIN { version } else { 0 };
            Converter::new(&session.api, &session.git, &mut session.map)
                .convert(server, Some(branch), at)
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

/// What Git compares a push against. A branch reports its local commit when this clone
/// knows it, else the platform id, which Git does not have and refuses as "fetch first",
/// exactly as with any remote that moved. Main reports the newest head this clone has
/// seen that the work being pushed (HEAD) builds on: landing merges concurrent changes
/// on the platform, so a stale main is no reason to refuse.
fn for_push_value(session: &Session, name: &str, server: &str) -> String {
    let known = session.map.local(server).map(str::to_owned);
    if name != MAIN {
        return known.unwrap_or_else(|| server.to_owned());
    }
    let builds_on = |local: &str| session.git.is_ancestor(local, "HEAD");
    if let Some(local) = known.as_deref().filter(|l| builds_on(l)) {
        return local.to_owned();
    }
    session
        .map
        .main_heads()
        .into_iter()
        .take(MAIN_CANDIDATES)
        .find(|(_, local, _)| builds_on(local))
        .map(|(_, local, _)| local.to_owned())
        .or(known)
        .unwrap_or_else(|| server.to_owned())
}
