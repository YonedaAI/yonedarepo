//! `yoneda clone`: a `git clone` through the `yoneda::` remote helper, lazy by default
//! (commits and trees; Git fetches each file's contents when it first needs them), with
//! `--full` for every object or `--sparse <dir,...>` for a checkout of only those
//! directories (Git's cone mode, so nothing outside them is fetched).
//!
//! `--offline`: the older offline checkout, synced through the API with `yoneda sync`. A
//! full `git clone` where the platform hands out read access (a person reading the whole
//! repository on an Artifacts-backed store), else a snapshot of the branch through the
//! API. Either way the checkout is pinned to the latest version.
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
    let cloned = match api.post("/clone", &serde_json::json!({})).await {
        Ok(access) => {
            git_clone(&access, target)?;
            true
        }
        // Tokens and R2-backed repositories cannot `git clone`, nor can a repository that
        // withholds quarantined content (the object store would serve it): take the API
        // snapshot, which refuses only a quarantined file it needs.
        Err(f) if ["FORBIDDEN", "NOT_SUPPORTED", "QUARANTINED"].contains(&f.code.as_str()) => {
            std::fs::create_dir_all(target).context(format!("creating {}", target.display()))?;
            Git::new(target).run(&["init", "-q", "-b", BRANCH])?;
            false
        }
        Err(f) => return Err(Error::new(format!("requesting clone access: {f}"))),
    };
    let git = Git::new(target);
    let local = if git.succeeds(&["cat-file", "-e", &format!("{head}^{{commit}}")]) {
        head.clone()
    } else {
        // The clone may lag the latest version (or there is no history yet).
        let parent = git.run(&["rev-parse", "--verify", "-q", "HEAD"]).ok();
        let message =
            format!("yoneda: {BRANCH} at version {version}\n\nPlatform commit {head} of {repo}.");
        snapshot::import(&api, &git, &head, parent.as_deref(), &message).await?
    };
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
        "Cloned {repo} into {} at version {version} ({})",
        target.display(),
        if cloned { "git clone" } else { "API snapshot" }
    );
    output::emit(&Cloned {
        repo: repo.to_owned(),
        dir: target.display().to_string(),
        version,
        method: if cloned {
            CloneMethod::GitClone
        } else {
            CloneMethod::ApiSnapshot
        },
        scope: Vec::new(),
    });
    Ok(())
}

/// `git clone` with the short-lived read token in the environment as an HTTP header
/// scoped to the remote: never on the command line, never written to `.git/config`.
fn git_clone(access: &serde_json::Value, target: &Path) -> Result<()> {
    let remote = access["remote"]
        .as_str()
        .filter(|r| r.starts_with("https://"))
        .ok_or_else(|| Error::new("the platform returned no https clone remote"))?;
    let token = access["token"]
        .as_str()
        .filter(|t| !t.is_empty() && !t.contains(['\r', '\n']))
        .ok_or_else(|| Error::new("the platform returned no clone token"))?;
    let (parent, name) = parent_and_name(target)?;
    let key = format!("http.{remote}.extraHeader");
    let header = format!("Authorization: Bearer {token}");
    let env = clone_env(&key, &header);
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    Git::new(parent)
        .output(&["clone", "-q", remote, name], None, &env)
        .map(|_| ())
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

/// Git's environment configuration (`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`).
fn clone_env(key: &str, value: &str) -> [(&'static str, String); 3] {
    [
        ("GIT_CONFIG_COUNT", "1".to_owned()),
        ("GIT_CONFIG_KEY_0", key.to_owned()),
        ("GIT_CONFIG_VALUE_0", value.to_owned()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Repo;

    #[test]
    fn the_clone_header_is_scoped_configuration_not_an_argument() -> Result<()> {
        let repo = Repo::new()?;
        let env = clone_env(
            "http.https://store.example/r.git.extraHeader",
            "Authorization: Bearer tok",
        );
        let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let seen = repo.git.output(
            &[
                "config",
                "--get",
                "http.https://store.example/r.git.extraheader",
            ],
            None,
            &env,
        )?;
        assert_eq!(
            String::from_utf8_lossy(&seen).trim(),
            "Authorization: Bearer tok"
        );
        let config = std::fs::read_to_string(repo.root().join(".git/config")).context("read")?;
        assert!(!config.contains("Bearer"));
        Ok(())
    }
}
