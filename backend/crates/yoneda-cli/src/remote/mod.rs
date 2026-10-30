//! `git-remote-yoneda`: the Git remote helper (gitremote-helpers(7)) with the `fetch`,
//! `push` and `option` capabilities. `git clone yoneda::https://<platform>/<repo-id>`,
//! then plain `git fetch`, `pull` and `push`. Commit ids are the platform's:
//! - list/fetch write the platform's commits byte for byte (see `fetch`);
//! - a push uploads every new commit first, each rebuilt by the platform as the same
//!   object (see `crate::replay`), then makes one compare-and-swap (or one batch for
//!   `--atomic`, one landing for main, or one creation for a new tag, an annotated one
//!   with its tag object), so nothing is visible before it.
//!
//! The commit map (`map`) keeps only the cases where ids cannot match. A clone is lazy by
//! default (`lazy`): history arrives as commits and trees, blobs when Git needs them.
pub mod convert;
mod declared;
mod fetch;
pub mod heads;
mod land;
mod lazy;
mod list;
pub mod map;
mod protocol;
mod push;
mod tags;
mod upload;
pub mod url;

pub use land::conflict_paths as land_conflict_paths;

use crate::api::Api;
use crate::credentials;
use crate::error::{Error, Result};
use crate::git::{self, Git};
use crate::snapshot::Filter;
use heads::MainHeads;
use map::CommitMap;
use std::path::PathBuf;
use url::RemoteUrl;

/// Options Git set with `option <name> <value>`.
#[derive(Debug, Default)]
pub struct Options {
    pub verbosity: u32,
    pub atomic: bool,
    pub dry_run: bool,
    /// `git push -o <option>` values (`yoneda.reads=…` declares the push's read set).
    pub push_options: Vec<String>,
}

/// One helper process: the repository, its platform remote, the commit map and main's
/// heads seen.
pub struct Session {
    pub url: RemoteUrl,
    pub api: Api,
    pub git: Git,
    pub git_dir: PathBuf,
    pub map: CommitMap,
    pub heads: MainHeads,
    pub options: Options,
    /// The remote's name, when Git gave one (not for a bare URL).
    pub remote: Option<String>,
    pub config: lazy::Config,
    /// What fetches bring (`lazy`).
    pub filter: Filter,
}

/// Reports progress on stderr, where Git passes it through to the person.
pub fn say(message: &str) {
    eprintln!("yoneda: {message}");
}

impl Session {
    /// Opens the session Git started: `argv` is `[remote-name, url]` (or `[url]`);
    /// `depth`: how many helpers this one runs inside (`git::HELPER_DEPTH`).
    pub fn open(argv: &[String], depth: u32) -> Result<Self> {
        let raw = argv
            .get(1)
            .or_else(|| argv.first())
            .ok_or_else(|| Error::usage("usage: git-remote-yoneda <remote> <url>"))?;
        let url = match url::parse(raw) {
            Ok(url) => url,
            Err(refused) => match url::parse_path(raw) {
                Some((origin, handle, name)) => resolve(&origin, &handle, &name)?,
                None => return Err(refused),
            },
        };
        let git_dir = std::env::var_os("GIT_DIR")
            .map(PathBuf::from)
            .ok_or_else(|| Error::new("GIT_DIR is not set; run this through git"))?;
        let cwd =
            std::env::current_dir().map_err(|e| Error::new(format!("current directory: {e}")))?;
        let git_dir = if git_dir.is_absolute() {
            git_dir
        } else {
            cwd.join(git_dir)
        };
        let api = api_for(&url)?;
        let remote = match argv {
            [name, url] if name != url && !name.contains(':') => Some(name.clone()),
            _ => None,
        };
        let git = Git::with_git_dir(&cwd, &git_dir).in_helper(depth);
        let config = lazy::Config::read(&git, remote.as_deref())?;
        Ok(Self {
            api,
            map: CommitMap::open(&git_dir, &url.repo)?,
            heads: MainHeads::open(&git_dir, &url.repo)?,
            filter: config.filter(),
            config,
            remote,
            git,
            url,
            git_dir,
            options: Options::default(),
        })
    }

    /// The local commit standing for platform commit `server`, when this clone holds
    /// it: `server` itself, or its stand-in from the commit map.
    pub fn held(&self, server: &str) -> Option<String> {
        let id = self.map.local(server).unwrap_or(server).to_owned();
        let missing = self.git.missing(std::slice::from_ref(&id)).ok()?;
        missing.is_empty().then_some(id)
    }

    /// Where a refused landing's conflicting paths are kept for `yoneda conflicts`.
    pub fn conflict_path(&self) -> PathBuf {
        conflict_file(&self.git_dir, &self.url.repo)
    }
}

/// The API for `url`'s repository with this person's token (`YONEDA_TOKEN`, else `yoneda
/// login`). Without one it still reads a public repository; the platform asks for
/// credentials (401) for anything else.
/// The repository `/<handle>/<name>` names on `origin`, asked of the platform with the
/// credential the helper uses there (a private one needs it; the answer is the same for one
/// that is not there and one the credential may not read).
fn resolve(origin: &str, handle: &str, name: &str) -> Result<RemoteUrl> {
    let token = credentials::load_optional(
        &credentials::default_path()?,
        origin,
        std::env::var("YONEDA_TOKEN").ok(),
    )?;
    resolve_with(origin, handle, name, token.as_ref())
}

fn resolve_with(
    origin: &str,
    handle: &str,
    name: &str,
    token: Option<&credentials::Token>,
) -> Result<RemoteUrl> {
    let api = Api::account(origin, token)?;
    let path = format!(
        "/resolve/{}/{}",
        crate::api::encode(handle),
        crate::api::encode(name)
    );
    let found = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| Error::new(format!("starting the runtime: {e}")))?
        .block_on(api.get(&path))
        .map_err(|failure| match failure.status {
            404 => Error::usage(format!(
                "{origin}/{handle}/{name} is not a repository you can read"
            )),
            _ => Error::from(failure),
        })?;
    let repo = found["id"]
        .as_str()
        .filter(|id| crate::api::valid_repo_id(id))
        .ok_or_else(|| Error::new("The platform answered no repository id"))?;
    Ok(RemoteUrl {
        origin: origin.to_owned(),
        repo: repo.to_owned(),
    })
}

pub fn api_for(url: &RemoteUrl) -> Result<Api> {
    let token = credentials::load_optional(
        &credentials::default_path()?,
        &url.origin,
        std::env::var("YONEDA_TOKEN").ok(),
    )?;
    match &token {
        Some(token) => Api::new(&url.origin, &url.repo, token),
        None => Api::anonymous(&url.origin, &url.repo),
    }
}

/// `$GIT_DIR/yoneda/<repo>.conflict`.
pub fn conflict_file(git_dir: &std::path::Path, repo: &str) -> PathBuf {
    git_dir.join("yoneda").join(format!("{repo}.conflict"))
}

/// The helper's entry point.
pub fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // A helper's Git run that needs an absent object starts one nested helper to fetch it
    // (a push reading a blob it never fetched); that one's runs never need another.
    let depth: u32 = std::env::var(git::HELPER_DEPTH)
        .ok()
        .and_then(|d| d.parse().ok())
        .unwrap_or(0);
    let outcome = if depth > 1 {
        Err(Error::new("a fetch inside a nested fetch is refused"))
    } else {
        Session::open(&argv, depth)
    };
    let outcome = outcome.and_then(|mut session| {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| Error::new(format!("starting the runtime: {e}")))?;
        let stdin = std::io::stdin();
        protocol::serve(&mut session, &rt, &mut stdin.lock(), &mut std::io::stdout())
    });
    if let Err(error) = outcome {
        say(&error.message);
        std::process::exit(error.exit_code.max(1));
    }
}

#[cfg(test)]
mod resolve_tests {
    use super::*;
    use std::io::{Read, Write};

    /// Serves one answer per connection: `/api/v1/resolve/ada/testing` names a repository,
    /// anything else is the platform's NOT_FOUND.
    fn platform() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for mut socket in listener.incoming().flatten() {
                let mut request = [0u8; 4096];
                let n = socket.read(&mut request).unwrap_or(0);
                let line = String::from_utf8_lossy(&request[..n]).to_string();
                let (status, body) = if line.starts_with("GET /api/v1/resolve/ada/testing ") {
                    (
                        "200 OK",
                        r#"{"id":"r0123456789abcdef0123","handle":"ada","name":"Testing","path":"/ada/Testing"}"#,
                    )
                } else {
                    (
                        "404 Not Found",
                        r#"{"error":{"code":"NOT_FOUND","message":"No such repository"}}"#,
                    )
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes());
            }
        });
        origin
    }

    #[test]
    fn a_readable_path_resolves_to_the_repository_it_names() {
        let origin = platform();
        let url = resolve_with(&origin, "ada", "testing", None).unwrap();
        assert_eq!(
            url,
            RemoteUrl {
                origin: origin.clone(),
                repo: "r0123456789abcdef0123".into()
            }
        );
        let missing = resolve_with(&origin, "ada", "other", None).unwrap_err();
        assert!(
            missing.message.contains("not a repository you can read"),
            "{}",
            missing.message
        );
    }
}
