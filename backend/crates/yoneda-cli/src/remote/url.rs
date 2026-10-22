//! Remote URLs: `yoneda::https://<platform>/<repo-id>` (Git strips `yoneda::` before
//! starting the helper) or `yoneda://<platform>/<repo-id>` (HTTPS). The platform may be
//! named by its own host or by a site that serves `/api/v1`.
use crate::api::valid_repo_id;
use crate::credentials::normalize_origin;
use crate::error::{Error, Result};

/// A platform origin and one repository on it.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct RemoteUrl {
    pub origin: String,
    pub repo: String,
}

/// Parses a remote URL as Git hands it to the helper (or as `git config` stores it).
pub fn parse(url: &str) -> Result<RemoteUrl> {
    let url = url.trim();
    let url = url.strip_prefix("yoneda::").unwrap_or(url);
    let https = url
        .strip_prefix("yoneda://")
        .map(|rest| format!("https://{rest}"));
    let url = https.as_deref().unwrap_or(url);
    let refused = || {
        Error::usage(format!(
            "{url:?} is not a yoneda remote: use yoneda::https://<platform>/<repo-id>"
        ))
    };
    let scheme_end = url.find("://").ok_or_else(refused)? + 3;
    let (origin, path) = match url[scheme_end..].find('/') {
        Some(slash) => url.split_at(scheme_end + slash),
        None => return Err(refused()),
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let repo = path
        .strip_prefix("/api/v1/repos/")
        .or_else(|| path.strip_prefix('/'))
        .filter(|r| valid_repo_id(r))
        .ok_or_else(refused)?;
    Ok(RemoteUrl {
        origin: normalize_origin(origin)?,
        repo: repo.to_owned(),
    })
}

impl RemoteUrl {
    /// The URL to give `git clone`.
    pub fn git_url(&self) -> String {
        format!("yoneda::{}/{}", self.origin, self.repo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO: &str = "r0123456789abcdef0123";

    #[test]
    fn accepts_each_spelling_of_a_remote() -> Result<()> {
        let want = RemoteUrl {
            origin: "https://api.dev.yonedarepo.com".into(),
            repo: REPO.into(),
        };
        for url in [
            format!("https://api.dev.yonedarepo.com/{REPO}"),
            format!("yoneda::https://api.dev.yonedarepo.com/{REPO}/"),
            format!("yoneda://api.dev.yonedarepo.com/{REPO}.git"),
            format!("https://api.dev.yonedarepo.com/api/v1/repos/{REPO}"),
        ] {
            assert_eq!(parse(&url)?, want, "{url}");
        }
        let local = parse(&format!("http://127.0.0.1:8787/{REPO}"))?;
        assert_eq!(local.origin, "http://127.0.0.1:8787");
        assert_eq!(
            local.git_url(),
            format!("yoneda::http://127.0.0.1:8787/{REPO}")
        );
        Ok(())
    }

    #[test]
    fn refuses_urls_without_a_repository_id() {
        for url in [
            "https://api.yonedarepo.com",
            "https://api.yonedarepo.com/",
            "https://api.yonedarepo.com/../etc",
            "git@github.com:a/b.git",
            "https://api.yonedarepo.com/a/r0123456789abcdef0123",
        ] {
            assert!(parse(url).is_err(), "{url}");
        }
    }
}
