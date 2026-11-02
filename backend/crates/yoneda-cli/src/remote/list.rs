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
    let path = format!("/refs?min_version={}", session.heads.minimum_version());
    let mut refs = session.api.get(&path).await?;
    let version = refs["version"]
        .as_u64()
        .ok_or_else(|| Error::new("the platform's refs have no version"))?;
    if version < session.heads.minimum_version() {
        return Err(Error::new(
            "the platform returned refs older than this clone has already seen",
        ));
    }
    session.heads.observe(version)?;
    if pending(&refs)? {
        // A UI can show the other refs while publication finishes. Git must see the
        // complete listing: pin this version rather than chase a moving latest head.
        refs = session.api.get(&format!("/refs?at={version}")).await?;
        if refs["version"].as_u64() != Some(version) || pending(&refs)? {
            return Err(Error::new(
                "the platform returned an incomplete pinned ref listing",
            ));
        }
    }
    Ok(Listed {
        version,
        heads: named(&refs["refs"]),
        annotated: named(&refs["annotated"]),
    })
}

fn pending(refs: &Value) -> Result<bool> {
    match refs.get("pending") {
        None => Ok(false),
        Some(value) => value
            .as_array()
            .map(|rows| !rows.is_empty())
            .ok_or_else(|| Error::new("the platform returned malformed pending refs")),
    }
}

/// Ref mutations and idempotent replays both carry an authoritative version.
pub fn observe_write(session: &Session, reply: &Value) -> std::result::Result<(), String> {
    match reply["version"].as_u64() {
        Some(version) => session
            .heads
            .observe(version)
            .map_err(|e| format!("published, but recording its version failed: {e}")),
        None => Err("published, but the platform returned no ref version".into()),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Api;
    use crate::git::Git;
    use crate::remote::{Options, heads::MainHeads, lazy, map::CommitMap, url::RemoteUrl};
    use crate::snapshot::Filter;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn pending_refs_are_read_at_the_same_version_instead_of_advertised_missing() {
        let dir = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for (i, socket) in listener.incoming().take(2).enumerate() {
                let mut socket = socket.unwrap();
                let mut input = [0; 4096];
                let n = socket.read(&mut input).unwrap();
                let body = if i == 0 {
                    serde_json::json!({"version":7,"refs":{},"annotated":{},"pending":["refs/heads/doomed"]})
                } else {
                    assert!(String::from_utf8_lossy(&input[..n]).contains("at=7"));
                    serde_json::json!({"version":7,"refs":{"refs/heads/doomed":"a".repeat(40)},"annotated":{}})
                }.to_string();
                write!(socket, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let session = super::super::test_support::session(&origin, dir.path()).unwrap();
        assert!(
            branches(&session)
                .await
                .unwrap()
                .heads
                .contains_key("refs/heads/doomed")
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn a_later_helper_cannot_lose_a_branch_an_earlier_helper_saw() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::new(e.to_string()))?;
        let repo = "r0123456789abcdef0123";
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| Error::new(e.to_string()))?;
        let origin = format!(
            "http://{}",
            listener
                .local_addr()
                .map_err(|e| Error::new(e.to_string()))?
        );
        let server = std::thread::spawn(move || {
            for (i, socket) in listener.incoming().take(2).enumerate() {
                let mut socket = socket.unwrap();
                let mut input = [0; 4096];
                let n = socket.read(&mut input).unwrap();
                let request = String::from_utf8_lossy(&input[..n]);
                let current = i == 0
                    || request
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .contains("min_version=7");
                let body = if current {
                    serde_json::json!({"version":7,"refs":{"refs/heads/doomed":"a".repeat(40)},"annotated":{}})
                } else {
                    serde_json::json!({"version":6,"refs":{},"annotated":{}})
                }.to_string();
                write!(socket, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let session = || -> Result<Session> {
            Ok(Session {
                url: RemoteUrl {
                    origin: origin.clone(),
                    repo: repo.into(),
                },
                api: Api::anonymous(&origin, repo)?,
                git: Git::new(dir.path()),
                git_dir: dir.path().into(),
                map: CommitMap::open(dir.path(), repo)?,
                heads: MainHeads::open(dir.path(), repo)?,
                options: Options::default(),
                remote: None,
                config: lazy::Config::default(),
                filter: Filter::Full,
            })
        };
        assert!(
            branches(&session()?)
                .await?
                .heads
                .contains_key("refs/heads/doomed")
        );
        assert!(
            branches(&session()?)
                .await?
                .heads
                .contains_key("refs/heads/doomed")
        );
        server
            .join()
            .map_err(|_| Error::new("fixture server stopped"))?;
        Ok(())
    }
}
