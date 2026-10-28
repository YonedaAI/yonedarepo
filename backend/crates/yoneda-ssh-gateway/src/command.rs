//! The one shape of SSH `exec` the gateway runs: `git-upload-pack` or `git-receive-pack`
//! with a single repository argument (`'r<20 hex>'`, optionally `/`-prefixed and
//! `.git`-suffixed, single-quoted as Git sends it or bare). Anything else is refused before
//! the platform hears of it, so no client-supplied text reaches a request it makes.
use std::fmt;

/// A Git service the gateway bridges to smart HTTP.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    UploadPack,
    ReceivePack,
}

impl Service {
    /// The service's name on the wire and in smart-HTTP paths.
    pub fn name(self) -> &'static str {
        match self {
            Service::UploadPack => "git-upload-pack",
            Service::ReceivePack => "git-receive-pack",
        }
    }
}

/// A repository id: `r` and 20 lowercase hex digits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoId(String);

impl RepoId {
    pub fn parse(text: &str) -> Option<RepoId> {
        let hex = text.strip_prefix('r')?;
        (hex.len() == 20 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
            .then(|| RepoId(text.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RepoId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A validated `exec` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommand {
    pub service: Service,
    pub repo: RepoId,
}

/// Parses an `exec` command line; `None` for anything the gateway does not run.
pub fn parse(command: &[u8]) -> Option<GitCommand> {
    let text = std::str::from_utf8(command).ok()?;
    if text.len() > 128 {
        return None;
    }
    let (program, argument) = text.split_once(' ')?;
    let service = match program {
        "git-upload-pack" => Service::UploadPack,
        "git-receive-pack" => Service::ReceivePack,
        _ => return None,
    };
    let path = match argument.strip_prefix('\'') {
        Some(quoted) => quoted.strip_suffix('\'')?,
        None => argument,
    };
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path.strip_suffix(".git").unwrap_or(path);
    Some(GitCommand {
        service,
        repo: RepoId::parse(path)?,
    })
}

/// Whether a `GIT_PROTOCOL` value (colon-separated `key=value` pairs) asks for version 2.
/// Only the gateway's own `version=2` header is ever sent on; the client's text is not.
pub fn wants_v2(git_protocol: Option<&str>) -> bool {
    git_protocol.is_some_and(|v| v.split(':').any(|p| p == "version=2"))
}

/// Whether an environment value is one the gateway keeps (`GIT_PROTOCOL` only).
pub fn plausible_git_protocol(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'=' | b':' | b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO: &str = "r0123456789abcdef0123";

    #[test]
    fn git_commands_in_every_form_git_sends() {
        for form in [
            format!("'{REPO}'"),
            format!("'/{REPO}'"),
            format!("'{REPO}.git'"),
            format!("'/{REPO}.git'"),
            REPO.to_owned(),
            format!("/{REPO}.git"),
        ] {
            let parsed = parse(format!("git-upload-pack {form}").as_bytes()).unwrap();
            assert_eq!(parsed.service, Service::UploadPack, "{form}");
            assert_eq!(parsed.repo.as_str(), REPO);
        }
        let push = parse(format!("git-receive-pack '{REPO}'").as_bytes()).unwrap();
        assert_eq!(push.service, Service::ReceivePack);
    }

    #[test]
    fn everything_else_is_refused() {
        for refused in [
            String::new(),
            "sh".into(),
            format!("git-upload-archive '{REPO}'"),
            format!("git upload-pack '{REPO}'"),
            format!("git-upload-pack '{REPO}"),
            format!("git-upload-pack {REPO}'"),
            format!("git-upload-pack \"{REPO}\""),
            format!("git-upload-pack '{REPO}' extra"),
            format!("git-upload-pack  '{REPO}'"),
            format!("git-upload-pack '{REPO}'; rm -rf /"),
            format!("git-upload-pack '../{REPO}'"),
            format!("git-upload-pack '//{REPO}'"),
            format!("git-upload-pack '{}'", REPO.to_uppercase()),
            "git-upload-pack 'r0123'".into(),
            format!("git-upload-pack '{REPO}.git.git'"),
            format!("git-upload-pack '{REPO}\n'"),
        ] {
            assert_eq!(parse(refused.as_bytes()), None, "{refused:?}");
        }
        assert_eq!(parse(&[0xff, 0xfe]), None);
    }

    #[test]
    fn protocol_version_two_is_read_from_git_protocol() {
        assert!(wants_v2(Some("version=2")));
        assert!(wants_v2(Some("object-format=sha1:version=2")));
        assert!(!wants_v2(Some("version=1")));
        assert!(!wants_v2(Some("version=20")));
        assert!(!wants_v2(None));
        assert!(plausible_git_protocol("version=2"));
        assert!(!plausible_git_protocol("version=2\r\nX-Evil: 1"));
        assert!(!plausible_git_protocol(&"v".repeat(65)));
    }
}
