//! `git-remote-yoneda`: the Git remote helper (gitremote-helpers(7)) with the `fetch`,
//! `push` and `option` capabilities. `git clone yoneda::https://<platform>/<repo-id>`,
//! then plain `git fetch`, `pull` and `push`. Commit ids are the platform's:
//! - list/fetch write the platform's commits byte for byte (see `fetch`);
//! - a push uploads every new commit first, each rebuilt by the platform as the same
//!   object (see `crate::replay`), then makes one compare-and-swap (or one batch for
//!   `--atomic`, one landing for main, or one creation for a new lightweight tag), so
//!   nothing is visible before it.
//!
//! The commit map (`map`) keeps only the cases where ids cannot match.
pub mod convert;
mod declared;
mod fetch;
pub mod heads;
mod land;
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
use crate::git::Git;
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
}

/// Reports progress on stderr, where Git passes it through to the person.
pub fn say(message: &str) {
    eprintln!("yoneda: {message}");
}

impl Session {
    /// Opens the session Git started: `argv` is `[remote-name, url]` (or `[url]`).
    pub fn open(argv: &[String]) -> Result<Self> {
        let raw = argv
            .get(1)
            .or_else(|| argv.first())
            .ok_or_else(|| Error::usage("usage: git-remote-yoneda <remote> <url>"))?;
        let url = url::parse(raw)?;
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
        let token = credentials::load(
            &credentials::default_path()?,
            &url.origin,
            std::env::var("YONEDA_TOKEN").ok(),
        )?;
        Ok(Self {
            api: Api::new(&url.origin, &url.repo, &token)?,
            git: Git::with_git_dir(&cwd, &git_dir),
            map: CommitMap::open(&git_dir, &url.repo)?,
            heads: MainHeads::open(&git_dir, &url.repo)?,
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

/// `$GIT_DIR/yoneda/<repo>.conflict`.
pub fn conflict_file(git_dir: &std::path::Path, repo: &str) -> PathBuf {
    git_dir.join("yoneda").join(format!("{repo}.conflict"))
}

/// The helper's entry point.
pub fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let outcome = Session::open(&argv).and_then(|mut session| {
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
