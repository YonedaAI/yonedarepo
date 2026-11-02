//! A helper session with a real HTTP client and an isolated local metadata directory.
use super::{Options, Session, heads::MainHeads, lazy, map::CommitMap, url::RemoteUrl};
use crate::{api::Api, error::Result, git::Git, snapshot::Filter};
use std::path::Path;

pub(super) fn session(origin: &str, dir: &Path) -> Result<Session> {
    let repo = "r0123456789abcdef0123";
    Ok(Session {
        url: RemoteUrl {
            origin: origin.into(),
            repo: repo.into(),
        },
        api: Api::anonymous(origin, repo)?,
        git: Git::new(dir),
        git_dir: dir.into(),
        map: CommitMap::open(dir, repo)?,
        heads: MainHeads::open(dir, repo)?,
        options: Options::default(),
        remote: None,
        config: lazy::Config::default(),
        filter: Filter::Full,
    })
}
