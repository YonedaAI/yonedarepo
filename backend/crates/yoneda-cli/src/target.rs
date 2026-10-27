//! Which platform and repository a command addresses: flags first, then the current
//! clone (its yoneda remote, or an offline checkout's state), then the stored login.
use crate::api::Api;
use crate::command::Target;
use crate::credentials::{self, Token};
use crate::error::{Error, Result};
use crate::git::Git;
use crate::remote::url::{self, RemoteUrl};
use crate::state::State;
use std::path::PathBuf;

/// Where `yoneda login` goes when nothing names a platform.
pub const DEFAULT_ORIGIN: &str = "https://api.yonedarepo.com";

/// The platform for account commands: `--origin`, `YONEDA_ORIGIN`, the stored login,
/// else the production platform.
pub fn account_origin(flag: Option<&str>) -> Result<String> {
    let env = std::env::var("YONEDA_ORIGIN")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let stored = credentials::stored_origin(&credentials::default_path()?);
    credentials::normalize_origin(
        flag.map(str::to_owned)
            .or(env)
            .or(stored)
            .as_deref()
            .unwrap_or(DEFAULT_ORIGIN),
    )
}

pub fn token_for(origin: &str) -> Result<Token> {
    credentials::load(
        &credentials::default_path()?,
        origin,
        std::env::var("YONEDA_TOKEN").ok(),
    )
}

/// The account API with the caller's token.
pub fn account_api(flag: Option<&str>) -> Result<(String, Api)> {
    let origin = account_origin(flag)?;
    let api = Api::account(&origin, Some(&token_for(&origin)?))?;
    Ok((origin, api))
}

/// The current directory's Git repository, when there is one.
pub struct Clone {
    pub git: Git,
    pub git_dir: PathBuf,
    pub remote: Option<RemoteUrl>,
    /// The Git remote with the platform's URL, `yoneda::` or smart HTTP (none for an
    /// offline checkout).
    pub remote_name: Option<String>,
}

/// The repository containing the current directory and its yoneda remote (preferring
/// `origin`), or an offline checkout's pinned repository.
pub fn current_clone() -> Option<Clone> {
    let cwd = std::env::current_dir().ok()?;
    let probe = Git::new(&cwd);
    let git_dir = PathBuf::from(probe.run(&["rev-parse", "--absolute-git-dir"]).ok()?);
    let urls = probe
        .run(&["config", "--get-regexp", r"^remote\..*\.url$"])
        .unwrap_or_default();
    let mut remotes: Vec<(bool, String, RemoteUrl)> = urls
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(' ')?;
            url::is_platform(value).then_some(())?;
            let name = key
                .strip_prefix("remote.")?
                .strip_suffix(".url")?
                .to_owned();
            Some((name != "origin", name, url::parse(value).ok()?))
        })
        .collect();
    remotes.sort_by_key(|(not_origin, _, _)| *not_origin);
    let first = remotes.into_iter().next();
    let remote_name = first.as_ref().map(|(_, name, _)| name.clone());
    let remote = first.map(|(_, _, r)| r).or_else(|| {
        let root = Git::toplevel(&cwd).ok()?;
        let state = State::load(&root).ok()?;
        Some(RemoteUrl {
            origin: state.origin,
            repo: state.repo,
        })
    });
    Some(Clone {
        git: Git::with_git_dir(&cwd, &git_dir),
        git_dir,
        remote,
        remote_name,
    })
}

/// A resolved repository command target.
pub struct Resolved {
    pub repo: String,
    pub api: Api,
    pub clone: Option<Clone>,
}

pub fn resolve(target: &Target) -> Result<Resolved> {
    let clone = current_clone();
    let from_clone = clone.as_ref().and_then(|c| c.remote.clone());
    let repo = target
        .repo
        .clone()
        .or_else(|| from_clone.as_ref().map(|r| r.repo.clone()))
        .ok_or_else(|| {
            Error::usage("no repository: pass --repo <id> or run this inside a yoneda clone")
        })?;
    let origin = match (&target.origin, &from_clone) {
        (Some(origin), _) => credentials::normalize_origin(origin)?,
        (None, Some(remote))
            if target.repo.is_none() || target.repo == Some(remote.repo.clone()) =>
        {
            remote.origin.clone()
        }
        _ => account_origin(None)?,
    };
    let api = Api::new(&origin, &repo, &token_for(&origin)?)?;
    Ok(Resolved { repo, api, clone })
}
