//! An existing yoneda checkout: its work tree, pinned state and platform client.
use crate::api::Api;
use crate::credentials::{self, Token};
use crate::error::Result;
use crate::git::Git;
use crate::state::State;
use std::path::PathBuf;

pub struct Checkout {
    pub root: PathBuf,
    pub git: Git,
    pub state: State,
    pub token: Token,
    pub api: Api,
}

impl Checkout {
    /// Opens the checkout containing the current directory.
    pub fn open() -> Result<Self> {
        let cwd = std::env::current_dir()
            .map_err(|e| crate::error::Error::new(format!("current directory: {e}")))?;
        let root = Git::toplevel(&cwd)?;
        let state = State::load(&root)?;
        let token = credentials::load(
            &credentials::default_path()?,
            &state.origin,
            std::env::var("YONEDA_TOKEN").ok(),
        )?;
        let api = Api::new(&state.origin, &state.repo, &token)?;
        Ok(Self {
            git: Git::new(&root),
            root,
            state,
            token,
            api,
        })
    }

    pub fn save(&self) -> Result<()> {
        self.state.save(&self.root)
    }

    /// The message of a local commit made on a platform snapshot.
    pub fn snapshot_message(&self, version: u64, platform_commit: &str) -> String {
        format!(
            "yoneda: {} at version {version}\n\nPlatform commit {platform_commit} of {}.",
            self.state.branch, self.state.repo
        )
    }

    /// Moves the current branch forward to `commit` when HEAD is its ancestor (the
    /// work tree is updated; Git refuses if uncommitted changes would be overwritten).
    pub fn fast_forward(&self, commit: &str) -> Result<()> {
        self.git
            .run(&["merge", "--ff-only", "-q", commit])
            .map(|_| ())
    }
}
