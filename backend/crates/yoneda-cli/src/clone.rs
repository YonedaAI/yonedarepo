//! `yoneda clone`: a `git clone` through the `yoneda::` remote helper, lazy by default
//! (commits and trees; Git fetches each file's contents when it first needs them), with
//! `--full` for every object or `--sparse <dir,...>` for a checkout of only those
//! directories (Git's cone mode, so nothing outside them is fetched).
//!
//! `--offline`: the older offline checkout, synced through the API with `yoneda sync`: a
//! snapshot of the branch through the API, pinned to the latest version.
use crate::api::Api;
use crate::command::CloneMode;
use crate::credentials;
use crate::error::{Context, Error, Result};
use crate::git::Git;
use crate::human;
use crate::output::{self, CloneMethod, Cloned};
use crate::remote::url::RemoteUrl;
use crate::state::{self, State};
use crate::{snapshot, sparse};
use std::path::{Path, PathBuf};

const BRANCH: &str = "main";

pub async fn clone(
    repo: &str,
    dir: Option<&str>,
    origin: Option<&str>,
    mode: CloneMode,
) -> Result<()> {
    let path = credentials::default_path()?;
    let origin = match origin
        .map(str::to_owned)
        .or_else(|| credentials::stored_origin(&path))
    {
        Some(origin) => credentials::normalize_origin(&origin)?,
        None => {
            return Err(Error::usage(
                "clone needs --origin <url> (or a prior `yoneda login`)",
            ));
        }
    };
    let target = PathBuf::from(dir.unwrap_or(repo));
    if target.exists()
        && std::fs::read_dir(&target)
            .map(|mut d| d.next().is_some())
            .unwrap_or(true)
    {
        return Err(Error::new(format!(
            "{} already exists and is not empty",
            target.display()
        )));
    }
    let url = RemoteUrl {
        origin: origin.clone(),
        repo: repo.to_owned(),
    }
    .git_url();
    let (parent, name) = parent_and_name(&target)?;
    let git = Git::new(parent);
    let (how, method, done) = match mode {
        CloneMode::Offline => return offline(repo, &origin, &path, &target).await,
        CloneMode::Full => {
            git.output(
                &["clone", "-q", "-c", "yoneda.lazy=false", &url, name],
                None,
                &[],
            )?;
            ("every object".to_owned(), CloneMethod::Full, None)
        }
        CloneMode::Lazy => {
            git.output(
                &["clone", "-q", "--filter=blob:none", &url, name],
                None,
                &[],
            )?;
            ("lazily".to_owned(), CloneMethod::Lazy, None)
        }
        CloneMode::Sparse(dirs) => {
            let dirs = snapshot::normalize_scope(&dirs)?;
            let scope: Vec<String> = dirs.iter().map(|d| format!("yoneda.scope={d}")).collect();
            let mut args = vec!["clone", "-q", "--filter=blob:none", "--no-checkout"];
            for setting in &scope {
                args.extend(["-c", setting.as_str()]);
            }
            args.extend([url.as_str(), name]);
            git.output(&args, None, &[])?;
            (
                format!("only {}", dirs.join(", ")),
                CloneMethod::Sparse,
                Some(dirs),
            )
        }
    };
    let scope = done.unwrap_or_default();
    if !scope.is_empty() {
        sparse::check_out(&Git::new(&target), &scope)?;
    }
    human!("Cloned {repo} into {} ({how})", target.display());
    output::emit(&Cloned {
        repo: repo.to_owned(),
        dir: target.display().to_string(),
        version: main_version(&target, repo),
        method,
        scope,
    });
    Ok(())
}

/// The log version at which the clone saw main (the helper records it, `remote::heads`).
fn main_version(target: &Path, repo: &str) -> u64 {
    let git = Git::new(target);
    let (Ok(git_dir), Ok(main)) = (
        git.run(&["rev-parse", "--absolute-git-dir"]),
        git.run(&["rev-parse", "--verify", "-q", "refs/remotes/origin/main"]),
    ) else {
        return 0;
    };
    crate::remote::heads::MainHeads::open(Path::new(&git_dir), repo)
        .map(|heads| heads.version(&main))
        .unwrap_or(0)
}

/// The offline checkout (`--offline`).
async fn offline(repo: &str, origin: &str, path: &Path, target: &Path) -> Result<()> {
    let token = credentials::load(path, origin, std::env::var("YONEDA_TOKEN").ok())?;
    let api = Api::new(origin, repo, &token)?;
    let origin = origin.to_owned();
    let (version, head) = api.branch_at_latest(BRANCH).await?;
    std::fs::create_dir_all(target).context(format!("creating {}", target.display()))?;
    let git = Git::new(target);
    git.run(&["init", "-q", "-b", BRANCH])?;
    let message =
        format!("yoneda: {BRANCH} at version {version}\n\nPlatform commit {head} of {repo}.");
    let local = snapshot::import(&api, &git, &head, None, &message).await?;
    git.run(&["checkout", "-q", "-B", BRANCH, &local])?;
    let state = State {
        repo: repo.to_owned(),
        origin,
        branch: BRANCH.to_owned(),
        base_version: version,
        base_commit: head,
        local_base: local,
        offline_branch: format!(
            "offline/{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ),
        offline_head: None,
        platform: Default::default(),
        series: Vec::new(),
        last_land: None,
        attempts: Default::default(),
    };
    let root = std::fs::canonicalize(target).context(format!("resolving {}", target.display()))?;
    state.save(&root)?;
    state::exclude(&root.join(git.run(&["rev-parse", "--git-dir"])?))?;
    human!(
        "Cloned {repo} into {} at version {version} (API snapshot)",
        target.display()
    );
    output::emit(&Cloned {
        repo: repo.to_owned(),
        dir: target.display().to_string(),
        version,
        method: CloneMethod::ApiSnapshot,
        scope: Vec::new(),
    });
    Ok(())
}

/// The directory to run `git clone` in (created) and the clone's name in it.
fn parent_and_name(target: &Path) -> Result<(&Path, &str)> {
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::new("the clone directory needs a UTF-8 name"))?;
    std::fs::create_dir_all(parent).context(format!("creating {}", parent.display()))?;
    Ok((parent, name))
}
