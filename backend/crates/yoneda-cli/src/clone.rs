//! `yoneda clone`: a full `git clone` where the platform hands out read access (a person
//! reading the whole repository on an Artifacts-backed store), else a snapshot of the
//! branch through the API. Either way the checkout is pinned to the latest version.
use crate::api::Api;
use crate::credentials;
use crate::error::{Context, Error, Result};
use crate::git::Git;
use crate::human;
use crate::output::{self, CloneMethod, Cloned};
use crate::snapshot;
use crate::state::{self, State};
use std::path::{Path, PathBuf};

const BRANCH: &str = "main";

pub async fn clone(repo: &str, dir: Option<&str>, origin: Option<&str>) -> Result<()> {
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
    let token = credentials::load(&path, &origin, std::env::var("YONEDA_TOKEN").ok())?;
    let api = Api::new(&origin, repo, &token)?;
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
    let (version, head) = api.branch_at_latest(BRANCH).await?;
    let cloned = match api.post("/clone", &serde_json::json!({})).await {
        Ok(access) => {
            git_clone(&access, &target)?;
            true
        }
        // Tokens and R2-backed repositories cannot `git clone`: take the API snapshot.
        Err(f) if f.code == "FORBIDDEN" || f.code == "NOT_SUPPORTED" => {
            std::fs::create_dir_all(&target).context(format!("creating {}", target.display()))?;
            Git::new(&target).run(&["init", "-q", "-b", BRANCH])?;
            false
        }
        Err(f) => return Err(Error::new(format!("requesting clone access: {f}"))),
    };
    let git = Git::new(&target);
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
    let root = std::fs::canonicalize(&target).context(format!("resolving {}", target.display()))?;
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
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::new("the clone directory needs a UTF-8 name"))?;
    std::fs::create_dir_all(parent).context(format!("creating {}", parent.display()))?;
    let key = format!("http.{remote}.extraHeader");
    let header = format!("Authorization: Bearer {token}");
    let env = clone_env(&key, &header);
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    Git::new(parent)
        .output(&["clone", "-q", remote, name], None, &env)
        .map(|_| ())
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
