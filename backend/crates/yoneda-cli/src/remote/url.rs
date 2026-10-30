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
        .or_else(|| path.strip_prefix("/git/"))
        .or_else(|| path.strip_prefix('/'))
        .filter(|r| valid_repo_id(r))
        .ok_or_else(refused)?;
    Ok(RemoteUrl {
        origin: normalize_origin(origin)?,
        repo: repo.to_owned(),
    })
}

/// A remote named by readable path (`yoneda::https://<platform>/<handle>/<name>`, any
/// spelling `parse` takes): its origin, the owner's handle and the repository's name, for
/// the platform to resolve to an id (`GET /api/v1/resolve/<handle>/<name>`).
pub fn parse_path(url: &str) -> Option<(String, String, String)> {
    let url = url.trim();
    let url = url.strip_prefix("yoneda::").unwrap_or(url);
    let https = url
        .strip_prefix("yoneda://")
        .map(|rest| format!("https://{rest}"));
    let url = https.as_deref().unwrap_or(url);
    let scheme_end = url.find("://")? + 3;
    let slash = url[scheme_end..].find('/')? + scheme_end;
    let (origin, path) = url.split_at(slash);
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (handle, name) = path.strip_prefix('/')?.split_once('/')?;
    let handle_ok = (3..=32).contains(&handle.len())
        && handle.as_bytes()[0].is_ascii_alphabetic()
        && handle
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_');
    let name_ok = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    (handle_ok && name_ok).then(|| {
        Some((
            normalize_origin(origin).ok()?,
            handle.to_ascii_lowercase(),
            name.to_owned(),
        ))
    })?
}

/// Whether `url` (a remote's configured URL) is the platform's: a `yoneda:` remote for the
/// helper, or stock Git over its smart HTTP.
pub fn is_platform(url: &str) -> bool {
    let url = url.trim();
    url.starts_with("yoneda:")
        || (url.starts_with("http") && url.contains("/git/") && parse(url).is_ok())
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
            format!("https://api.dev.yonedarepo.com/git/{REPO}.git"),
        ] {
            assert_eq!(parse(&url)?, want, "{url}");
        }
        assert!(is_platform(&format!(
            "https://api.dev.yonedarepo.com/git/{REPO}.git"
        )));
        assert!(is_platform(&format!(
            "yoneda::https://api.dev.yonedarepo.com/{REPO}"
        )));
        assert!(!is_platform("https://github.com/git/example.git"));
        assert!(!is_platform(&format!(
            "https://api.dev.yonedarepo.com/{REPO}"
        )));
        let local = parse(&format!("http://127.0.0.1:8787/{REPO}"))?;
        assert_eq!(local.origin, "http://127.0.0.1:8787");
        assert_eq!(
            local.git_url(),
            format!("yoneda::http://127.0.0.1:8787/{REPO}")
        );
        Ok(())
    }

    #[test]
    fn reads_a_readable_path_for_the_platform_to_resolve() {
        let want = Some((
            "https://dev.yonedarepo.com".to_owned(),
            "ada".to_owned(),
            "Testing".to_owned(),
        ));
        for url in [
            "yoneda::https://dev.yonedarepo.com/ada/Testing",
            "yoneda://dev.yonedarepo.com/Ada/Testing.git",
            "https://dev.yonedarepo.com/ada/Testing/",
        ] {
            assert_eq!(parse_path(url), want, "{url}");
        }
        for url in [
            "https://dev.yonedarepo.com/ada",
            "https://dev.yonedarepo.com/ada/a/b",
            "https://dev.yonedarepo.com/a/repo",
            "https://dev.yonedarepo.com/ada/.hidden",
            "git@github.com:ada/repo.git",
        ] {
            assert_eq!(parse_path(url), None, "{url}");
        }
        // An id path is never a readable one's job.
        assert!(parse(&format!("https://dev.yonedarepo.com/{REPO}")).is_ok());
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
